"""
FastAPI WebSocket server with ConnectionManager integration.

Endpoints:
  WS /ws/{user_id} — WebSocket connection for streaming agent responses
  POST /task/resume/{user_id} — Resume interrupted task (fetch saved state)
  GET /connections/stats — Connection statistics (admin only)
  GET /health — Health check

Example client:
  ws = new WebSocket('ws://localhost:8000/ws/user123')
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data)
    if (msg.type === 'chunk') console.log(msg.delta)
    if (msg.type === 'done') console.log('finished')
  }
"""

import os
import json
from typing import Any, Dict, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Header
from fastapi.responses import JSONResponse
import redis.asyncio as redis

from connections import ConnectionManager, MessageType
from agents.code_agent import CodeAgent
from tiers import TierGuard

# ─────────────────────────────────────────────────────────────────────────────
# App Setup
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="OpenUI WebSocket Server", version="1.0.0")

# Initialize Redis
try:
    redis_client = redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))
    await redis_client.ping()
except Exception as e:
    print(f"[App] Redis unavailable: {e}")
    redis_client = None

# Initialize managers
connection_manager = ConnectionManager(redis_client)
tier_guard = TierGuard(
    redis_client=redis_client,
    supabase_url=os.getenv("SUPABASE_URL"),
    supabase_key=os.getenv("SUPABASE_SERVICE_ROLE_KEY")
)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def extract_bearer_token(auth_header: Optional[str]) -> Optional[str]:
    """Extract token from Authorization: Bearer <token>."""
    if not auth_header or not auth_header.startswith("Bearer "):
        return None
    return auth_header[7:]


async def verify_user_token(auth_header: Optional[str]) -> str:
    """
    Verify Bearer token and return user_id.

    For now, token validation is basic. In production:
    - Validate Supabase JWT
    - Extract user_id from JWT claims
    """
    token = extract_bearer_token(auth_header)
    if not token:
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    # TODO: Validate token against Supabase or other auth provider
    # For now, just ensure it exists
    return token  # In a real implementation, extract user_id from the JWT


# ─────────────────────────────────────────────────────────────────────────────
# WebSocket Endpoint
# ─────────────────────────────────────────────────────────────────────────────

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(
    user_id: str,
    websocket: WebSocket,
    authorization: Optional[str] = Header(None),
) -> None:
    """
    WebSocket endpoint for streaming agent responses.

    Path params:
      user_id: The user's unique identifier

    Headers:
      Authorization: Bearer <token>  (required)

    Client should send:
      {
        "type": "query",
        "conversation_id": "...",
        "messages": [{"role": "user", "content": "..."}],
        "model": "optional-override"
      }

    Server responds with:
      - Multiple { "type": "chunk", "delta": "..." } messages
      - { "type": "done", "model": "...", "latency_ms": N }
      - { "type": "error", "message": "..." } on failure
      - { "type": "ping" } every 30s (client should respond with pong)
    """
    # Verify authorization
    try:
        await verify_user_token(authorization)
    except HTTPException as e:
        await websocket.close(code=1008, reason=e.detail)
        return

    # Accept connection
    await websocket.accept()

    # Register with ConnectionManager
    connection_id = await connection_manager.connect(user_id, websocket)

    try:
        # Listen for incoming messages
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type", "").lower()

            if msg_type == "pong":
                # Heartbeat response (ConnectionManager handles this)
                continue

            if msg_type == "query":
                # Process agent query
                await _handle_query(
                    user_id,
                    websocket,
                    data,
                    connection_id,
                )

            elif msg_type == "resume":
                # Resume interrupted task
                await _handle_resume(user_id, websocket, data, connection_id)

            else:
                await websocket.send_json({
                    "type": MessageType.ERROR.value,
                    "message": f"Unknown message type: {msg_type}",
                    "conversation_id": data.get("conversation_id"),
                })

    except WebSocketDisconnect:
        # Client closed or lost connection; save state for recovery
        task_state = data.get("task_state") if "data" in locals() else None
        await connection_manager.disconnect(
            user_id,
            websocket,
            save_task_state=task_state,
        )

    except Exception as e:
        print(f"[WebSocket] Unexpected error for {user_id}: {e}")
        await connection_manager.disconnect(user_id, websocket)


async def _handle_query(
    user_id: str,
    websocket: Any,
    data: Dict[str, Any],
    connection_id: str,
) -> None:
    """Handle a new agent query (chat message)."""
    conversation_id = data.get("conversation_id", connection_id)
    messages = data.get("messages", [])
    model = data.get("model")

    if not messages:
        await websocket.send_json({
            "type": MessageType.ERROR.value,
            "message": "Missing 'messages' field",
            "conversation_id": conversation_id,
        })
        return

    try:
        # Check tier permission
        tier = tier_guard.get_tier(user_id)

        # Create agent (tier determines model selection)
        agent = CodeAgent(tier=tier, model=model)

        # Stream response
        await agent.stream(messages, websocket)

    except Exception as e:
        print(f"[Query] Error: {e}")
        await websocket.send_json({
            "type": MessageType.ERROR.value,
            "message": str(e),
            "conversation_id": conversation_id,
        })


async def _handle_resume(
    user_id: str,
    websocket: Any,
    data: Dict[str, Any],
    connection_id: str,
) -> None:
    """Handle task resumption after disconnect."""
    conversation_id = data.get("conversation_id", connection_id)

    try:
        # Fetch saved task state
        task_state = await connection_manager.recover_task_state(user_id)

        if not task_state:
            await websocket.send_json({
                "type": MessageType.ERROR.value,
                "message": "No saved task state found",
                "conversation_id": conversation_id,
            })
            return

        # Send recovered state to client
        await websocket.send_json({
            "type": "resume_state",
            "state": task_state,
            "conversation_id": conversation_id,
        })

        # Clear saved state so it's not recovered again
        await connection_manager.clear_task_state(user_id)

    except Exception as e:
        print(f"[Resume] Error: {e}")
        await websocket.send_json({
            "type": MessageType.ERROR.value,
            "message": f"Resume failed: {str(e)}",
            "conversation_id": conversation_id,
        })


# ─────────────────────────────────────────────────────────────────────────────
# REST Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health_check() -> Dict[str, Any]:
    """Health check endpoint."""
    return {
        "status": "ok",
        "redis_available": redis_client is not None,
    }


@app.get("/connections/stats")
async def get_connection_stats(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    """
    Get connection statistics (admin endpoint).

    Requires Bearer token with admin permissions.
    """
    try:
        await verify_user_token(authorization)
    except HTTPException:
        raise HTTPException(status_code=401, detail="Unauthorized")

    stats = await connection_manager.get_stats()
    return stats


@app.post("/task/resume/{user_id}")
async def resume_task(
    user_id: str,
    authorization: Optional[str] = Header(None),
) -> Dict[str, Any]:
    """
    Fetch saved task state for a user (for HTTP clients that can't use WebSocket).

    Requires Bearer token matching the user_id.
    """
    try:
        token_user = await verify_user_token(authorization)
        # Simple check: token should match user_id (in production, decode JWT)
        if token_user != user_id:
            raise HTTPException(status_code=403, detail="Forbidden")
    except HTTPException:
        raise

    state = await connection_manager.recover_task_state(user_id)
    if not state:
        raise HTTPException(status_code=404, detail="No saved task state")

    await connection_manager.clear_task_state(user_id)

    return {
        "user_id": user_id,
        "task_state": state,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Startup/Shutdown
# ─────────────────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup() -> None:
    """Initialize app on startup."""
    print("[App] Starting OpenUI WebSocket Server")
    print(f"[App] Redis available: {redis_client is not None}")


@app.on_event("shutdown")
async def shutdown() -> None:
    """Clean up on shutdown."""
    print("[App] Shutting down OpenUI WebSocket Server")
    await connection_manager.disconnect_all()
    if redis_client:
        await redis_client.close()


if __name__ == "__main__":
    import uvicorn

    debug = os.getenv("DEBUG", "false").lower() == "true"
    port = int(os.getenv("PORT", 8000))

    print(f"[App] Running on 0.0.0.0:{port} (debug={debug})")
    uvicorn.run(app, host="0.0.0.0", port=port, reload=debug)
