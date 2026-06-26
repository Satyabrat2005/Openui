"""
OpenUI Multi-User FastAPI Server

WebSocket endpoint: /ws/{user_id}  — persistent streaming connection per user
HTTP endpoint:      POST /chat     — fallback for non-streaming clients
Health check:       GET /health    — liveness + dependency status
"""

import json
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Optional

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict

from connections import ConnectionManager

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "postgresql+asyncpg://openui:openui@localhost:5432/openui"
    redis_url: str = "redis://localhost:6379"
    ollama_host: str = "http://localhost:11434"
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    anthropic_api_key: str = ""
    openai_api_key: str = ""

    version: str = "0.2.0"
    # In prod, replace "*" with your Electron app's origin (e.g. "app://.")
    cors_origins: list[str] = ["*"]


settings = Settings()

# ---------------------------------------------------------------------------
# Structured JSON logging
# ---------------------------------------------------------------------------

class _JSONFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "level": record.levelname,
            "time": self.formatTime(record, self.datefmt),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if hasattr(record, "request_id"):
            payload["request_id"] = record.request_id
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload)


_handler = logging.StreamHandler()
_handler.setFormatter(_JSONFormatter())
logging.root.handlers = [_handler]
logging.root.setLevel(logging.INFO)
logger = logging.getLogger("openui.server")

# ---------------------------------------------------------------------------
# App state (singletons shared across requests)
# ---------------------------------------------------------------------------

class _AppState:
    redis: Optional[aioredis.Redis] = None
    connection_manager: Optional[ConnectionManager] = None


_state = _AppState()

# ---------------------------------------------------------------------------
# Lifespan — startup / shutdown hooks
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("OpenUI server starting up", extra={"request_id": "startup"})

    # Redis
    try:
        _state.redis = aioredis.from_url(settings.redis_url, decode_responses=True)
        await _state.redis.ping()
        logger.info("Redis connected", extra={"request_id": "startup"})
    except Exception as exc:
        logger.warning("Redis unavailable: %s", exc, extra={"request_id": "startup"})
        _state.redis = None

    # Initialize connection manager with optional Redis for state persistence
    _state.connection_manager = ConnectionManager(redis_client=_state.redis)
    logger.info("Connection manager initialized", extra={"request_id": "startup"})

    yield  # server is live

    # Shutdown
    if _state.redis:
        await _state.redis.aclose()
    logger.info("OpenUI server shut down", extra={"request_id": "shutdown"})

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="OpenUI Server",
    version=settings.version,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Attach a short request ID to every HTTP request/response
@app.middleware("http")
async def _request_id_middleware(request: Request, call_next):
    request_id = str(uuid.uuid4())[:8]
    request.state.request_id = request_id
    logger.info(
        "%s %s", request.method, request.url.path,
        extra={"request_id": request_id},
    )
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    user_id: str
    message: str
    session_id: Optional[str] = None


class ChatResponse(BaseModel):
    reply: str
    session_id: str
    request_id: str

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health(request: Request):
    """Liveness + dependency probe used by load balancers and /health UIs."""
    request_id = getattr(request.state, "request_id", "unknown")

    # Ollama probe
    ollama_ok = False
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{settings.ollama_host}/api/tags")
            ollama_ok = resp.status_code == 200
    except Exception:
        pass

    # Redis probe
    redis_ok = False
    if _state.redis:
        try:
            await _state.redis.ping()
            redis_ok = True
        except Exception:
            pass

    logger.info("Health check", extra={"request_id": request_id})
    return {
        "status": "ok",
        "version": settings.version,
        "ollama_connected": ollama_ok,
        "redis_connected": redis_ok,
        "ws_users": _state.connection_manager.connected_users_count(),
        "ws_connections": _state.connection_manager.total_connections_count(),
    }


@app.post("/chat", response_model=ChatResponse)
async def chat(body: ChatRequest, request: Request):
    """Synchronous (non-streaming) chat for clients that can't hold a WebSocket."""
    request_id = getattr(request.state, "request_id", str(uuid.uuid4())[:8])
    session_id = body.session_id or str(uuid.uuid4())

    logger.info(
        "POST /chat user=%s session=%s", body.user_id, session_id,
        extra={"request_id": request_id},
    )

    # TODO Task 2: route body.message through SessionManager → TaskRouter → Agent
    reply = f"[echo] {body.message}"

    return ChatResponse(reply=reply, session_id=session_id, request_id=request_id)


@app.websocket("/ws/{user_id}")
async def ws_endpoint(websocket: WebSocket, user_id: str):
    """Persistent WebSocket connection — supports multiple tabs/devices per user."""
    manager = _state.connection_manager
    await manager.connect(user_id, websocket)

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type", "message")
            conversation_id = data.get("conversation_id", str(uuid.uuid4()))

            # Handle heartbeat pong
            if msg_type == "pong":
                logger.debug("Pong received: user=%s", user_id)
                continue

            # Handle regular messages
            message = data.get("message", "")
            logger.info(
                "WS msg user=%s conv=%s: %s", user_id, conversation_id, message[:120],
                extra={"request_id": conversation_id},
            )

            # Mark conversation as active for resumption tracking
            await manager.mark_conversation_active(user_id, conversation_id)

            # TODO Task 2: route through SessionManager → TaskRouter → Agent,
            # streaming partial tokens back via manager.send(user_id, {...})
            await manager.send(user_id, {
                "type": "reply",
                "conversation_id": conversation_id,
                "content": f"[echo] {message}",
            })

    except WebSocketDisconnect:
        await manager.disconnect(user_id, websocket)
    except Exception as exc:
        logger.error(
            "WS error user=%s: %s", user_id, exc,
            extra={"request_id": user_id},
        )
        await manager.disconnect(user_id, websocket)
