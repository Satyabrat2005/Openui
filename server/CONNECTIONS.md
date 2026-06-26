# WebSocket Connection Manager

Robust lifecycle management for multi-user, multi-device WebSocket connections.

## Features

- **Multi-device support**: One user can have multiple concurrent WebSocket connections (browser tabs, different devices)
- **Heartbeat monitoring**: Automatic ping/pong every 30s to detect stale connections
- **Message envelope**: Standard message format with type, conversation_id, and timestamp
- **State persistence**: Task state saved to Redis on disconnect for resumption on reconnect
- **Graceful degradation**: Works with or without Redis for state persistence
- **Metrics**: Real-time visibility into connected users and total connections

## Architecture

### Core Class: `ConnectionManager`

```python
class ConnectionManager:
    def __init__(self, redis_client: Optional[aioredis.Redis] = None)
```

Manages WebSocket lifecycle with per-user connection tracking.

#### Data Structure

```python
_connections: Dict[user_id, List[WebSocket]]
```

Allows one user to have multiple tabs/devices open, each with its own WebSocket.

### Connection Lifecycle

1. **Connect**: `await manager.connect(user_id, websocket)`
   - Accepts the WebSocket
   - Adds it to the user's connection list
   - Starts a heartbeat monitor task
   - Logs connection event

2. **Heartbeat**: (automatic, every 30 seconds)
   - Sends `{"type": "ping"}` to client
   - Client should respond with `{"type": "pong"}`
   - If send fails (connection dead), automatically disconnects

3. **Message Handling**: Main event loop handles messages
   - Ignore `pong` messages (heartbeat responses)
   - Process regular messages (route through SessionManager, TaskRouter, etc.)

4. **Disconnect**: `await manager.disconnect(user_id, websocket)`
   - Removes connection from list
   - Cancels heartbeat monitor
   - Cleans up user entry if no more connections remain
   - Logs disconnection event

## API Reference

### Connection Management

```python
# Accept a new connection
await manager.connect(user_id: str, websocket: WebSocket) -> None

# Close a connection
await manager.disconnect(user_id: str, websocket: WebSocket) -> None

# Check if user has active connections
is_connected(user_id: str) -> bool
```

### Message Delivery

```python
# Send to all of user's WebSocket connections
await manager.send(user_id: str, message: dict) -> None

# Send to all connected users
await manager.broadcast(message: dict) -> None
```

### Metrics

```python
# Number of users with active connections
manager.connected_users_count() -> int

# Total number of active WebSocket connections
manager.total_connections_count() -> int
```

### State Persistence

```python
# Save task state for resumption on reconnect
await manager.save_task_state(
    user_id: str, 
    conversation_id: str, 
    task_state: dict
) -> None

# Load previously saved task state
await manager.load_task_state(
    user_id: str, 
    conversation_id: str
) -> Optional[dict]

# Track active conversations for user
await manager.mark_conversation_active(
    user_id: str, 
    conversation_id: str
) -> None

# Retrieve active conversations for user
await manager.get_active_conversations(user_id: str) -> set[str]
```

## Message Envelope Format

All messages are wrapped in a standard envelope:

```json
{
  "type": "message|chunk|done|error|tool_start|tool_result|routing|usage_update|ping|pong",
  "conversation_id": "string",
  "timestamp": "2024-01-15T10:30:45.123456+00:00",
  ...other fields
}
```

The `ConnectionManager._wrap_message()` automatically adds `type`, `conversation_id`, and `timestamp` if missing.

Example message types:
- `message`: Regular chat message
- `chunk`: Streaming token from model
- `done`: Task completion
- `error`: Error occurred
- `tool_start`: Tool invocation starting
- `tool_result`: Tool result returned
- `routing`: Task routing information
- `usage_update`: Token usage update
- `ping`: Heartbeat ping (sent by server)
- `pong`: Heartbeat pong (sent by client)

## Usage Example

### Integration with FastAPI

```python
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from connections import ConnectionManager

app = FastAPI()
manager = ConnectionManager(redis_client=redis)

@app.websocket("/ws/{user_id}")
async def ws_endpoint(websocket: WebSocket, user_id: str):
    await manager.connect(user_id, websocket)
    
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type", "message")
            conversation_id = data.get("conversation_id", str(uuid.uuid4()))
            
            # Skip heartbeat pong
            if msg_type == "pong":
                continue
            
            # Mark conversation as active for resumption tracking
            await manager.mark_conversation_active(user_id, conversation_id)
            
            # Route message through SessionManager → TaskRouter → Agent
            # (Task 2 implementation)
            await manager.send(user_id, {
                "type": "reply",
                "conversation_id": conversation_id,
                "content": "Response from agent",
            })
    
    except WebSocketDisconnect:
        await manager.disconnect(user_id, websocket)
    except Exception as exc:
        logger.error("WS error: %s", exc)
        await manager.disconnect(user_id, websocket)
```

### Broadcasting Server Status

```python
# Notify all users of system event
await manager.broadcast({
    "type": "routing",
    "message": "Server maintenance scheduled in 5 minutes",
})
```

### Resume After Disconnect

```python
# When user reconnects with same user_id
user_id = "user123"
conversation_id = "conv456"

# Check if there's saved task state
saved_state = await manager.load_task_state(user_id, conversation_id)
if saved_state:
    # Resume from saved state
    print(f"Resuming task: {saved_state}")
else:
    # Start fresh
    print("Starting new task")
```

## Redis State Persistence

Task state is persisted to Redis with 7-day TTL for automatic cleanup.

### Redis Keys

```
task_state:{user_id}:{conversation_id}  → JSON-serialized task state
active_convs:{user_id}                  → Set of active conversation IDs
```

Example Redis usage:

```bash
# Check saved task state
GET task_state:user123:conv456
# Output: {"step":2,"tokens_generated":150,...}

# Check active conversations for user
SMEMBERS active_convs:user123
# Output: ["conv456", "conv789"]
```

## Heartbeat Configuration

The heartbeat parameters can be customized:

```python
class ConnectionManager:
    HEARTBEAT_INTERVAL = 30  # seconds between pings
    HEARTBEAT_TIMEOUT = 10   # seconds to wait for pong (simplified)
```

For production, adjust based on:
- Network latency (increase if high)
- Desired responsiveness (decrease for faster detection)
- Client resources (decrease to reduce overhead)

## Error Handling

### Connection Failures

The manager gracefully handles:
- Client disconnect mid-message: Automatic cleanup via exception handling
- Stale heartbeats: Detected and cleaned up by heartbeat monitor
- Redis unavailable: State persistence is skipped, connections continue working

### Sending to Disconnected Users

`manager.send()` silently returns if user has no active connections (no error).

### Failed Message Delivery

If sending to a specific connection fails:
1. Error is logged
2. That connection is automatically disconnected
3. User's other connections remain active

## Monitoring

### Health Check Endpoint

```python
@app.get("/health")
async def health():
    return {
        "ws_users": manager.connected_users_count(),
        "ws_connections": manager.total_connections_count(),
    }
```

### Logging

All connection events are logged with `logger.info()`:
- User connect/disconnect
- Heartbeat events
- Send failures
- State persistence success/failure

Example logs:
```json
{"level": "INFO", "msg": "WS connected: user=user123 index=0 (total=1)"}
{"level": "INFO", "msg": "WS disconnected: user=user123 index=0 (remaining=0)"}
{"level": "DEBUG", "msg": "Heartbeat ping sent: user=user123 index=0"}
{"level": "INFO", "msg": "Saved task state: user=user123 conversation=conv456"}
```

## Testing

Run tests with pytest:

```bash
pytest server/test_connections.py -v
```

Key test scenarios:
- Single and multiple connections per user
- Message delivery to all user connections
- Broadcasting to all users
- State persistence (with mock Redis)
- Graceful degradation without Redis
- Connection metrics

## Thread Safety

The `ConnectionManager` is designed for async/await concurrency model (FastAPI/Starlette). It is **not thread-safe** for multi-threaded access. If you need to access it from multiple threads, add locking:

```python
import asyncio

manager = ConnectionManager(redis_client=redis)
lock = asyncio.Lock()

async def safe_send(user_id: str, message: dict):
    async with lock:
        await manager.send(user_id, message)
```

## Future Enhancements

Potential improvements for Task 3+:
- Connection-level rate limiting
- Per-user connection limits
- Graceful reconnection with connection tokens
- Metrics export (Prometheus)
- Connection pooling for high-load scenarios
- TLS/mTLS for secure inter-service communication
