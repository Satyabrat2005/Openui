# WebSocket Connection Manager Guide

The `ConnectionManager` provides robust WebSocket lifecycle management with heartbeat monitoring, multi-tab support, and state recovery.

## Overview

- **Multi-connection**: Each user can have multiple simultaneous WebSocket connections (tabs, devices)
- **Heartbeat**: Automatic ping/pong every 30 seconds with 10-second timeout
- **State Recovery**: Task state is saved to Redis on disconnect; users can reconnect and resume
- **Message Envelope**: All messages follow a standard format with type, conversation_id, timestamp
- **Broadcast**: Send messages to specific users or all connected clients

## Setup

### 1. Install Dependencies

```bash
pip install -r server/requirements.txt
```

### 2. Start Redis (for state recovery)

```bash
redis-server --port 6379
```

Or with Docker:
```bash
docker run -d -p 6379:6379 redis:latest
```

### 3. Set Environment Variables

```bash
export REDIS_URL=redis://localhost:6379
export ANTHROPIC_API_KEY=sk-...
export SUPABASE_URL=https://...supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...
```

### 4. Start the WebSocket Server

```bash
python server/fastapi_app.py
# Or with uvicorn:
# uvicorn server.fastapi_app:app --host 0.0.0.0 --port 8000 --reload
```

## Architecture

### ConnectionManager Class

```python
class ConnectionManager:
    # Track active connections: Dict[user_id, List[WebSocket]]
    active_connections: Dict[str, List[Any]]

    # Heartbeat tasks: (user_id, connection_id) -> asyncio.Task
    heartbeat_tasks: Dict[tuple, asyncio.Task]

    # Redis connection (optional, for state recovery)
    redis: redis.asyncio.Redis
```

### Message Envelope Format

All messages sent through the connection manager follow this format:

```python
{
    "type": "chunk" | "done" | "error" | "tool_start" | "tool_result" | 
            "routing" | "usage_update" | "ping" | "pong",
    "conversation_id": "conv-123",  # Optional if provided to send()
    "timestamp": "2025-06-26T14:30:00.123456Z",
    ...payload fields...
}
```

## Client-Side Usage (JavaScript/TypeScript)

### Basic Connection

```javascript
const userId = "user123";
const token = "your-bearer-token";

const ws = new WebSocket(`ws://localhost:8000/ws/${userId}`, [], {
  headers: {
    "Authorization": `Bearer ${token}`
  }
});

ws.addEventListener("open", () => {
  console.log("Connected");
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  
  if (msg.type === "ping") {
    // Respond to heartbeat
    ws.send(JSON.stringify({ type: "pong" }));
  } else if (msg.type === "chunk") {
    console.log("Received:", msg.delta);
  } else if (msg.type === "done") {
    console.log("Done. Model:", msg.model, "Latency:", msg.latency_ms, "ms");
  } else if (msg.type === "error") {
    console.error("Error:", msg.message);
  }
});

ws.addEventListener("close", () => {
  console.log("Disconnected");
  // Attempt reconnect or resume saved task state
});
```

### Sending a Query

```javascript
ws.send(JSON.stringify({
  "type": "query",
  "conversation_id": "conv-123",
  "messages": [
    {
      "role": "user",
      "content": "Fix this bug: [code]"
    }
  ],
  "model": "llama3:70b"  // Optional, uses tier default if omitted
}));
```

### Resuming After Disconnect

```javascript
// 1. When reconnecting, send resume request
ws.send(JSON.stringify({
  "type": "resume",
  "conversation_id": "conv-123"
}));

// 2. Receive recovered task state
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  
  if (msg.type === "resume_state") {
    const taskState = msg.state;
    console.log("Recovered task state:", taskState);
    // Continue with the recovered state
  }
});
```

## Server-Side Usage (Python)

### Creating and Using the Manager

```python
from connections import ConnectionManager
import redis.asyncio as redis

# Initialize
redis_client = redis.from_url("redis://localhost:6379")
manager = ConnectionManager(redis_client)

# On WebSocket connect
async def websocket_endpoint(user_id: str, websocket: WebSocket):
    await websocket.accept()
    
    connection_id = await manager.connect(user_id, websocket)
    print(f"User {user_id} connected")
    
    try:
        while True:
            data = await websocket.receive_json()
            
            if data["type"] == "query":
                # Process the query
                messages = data["messages"]
                model = data.get("model")
                
                # Stream response (e.g., using CodeAgent)
                agent = CodeAgent(tier="pro")
                await agent.stream(messages, websocket)
    
    except WebSocketDisconnect:
        # Save task state for recovery
        task_state = {
            "conversation_id": data.get("conversation_id"),
            "status": "interrupted",
            "timestamp": datetime.utcnow().isoformat()
        }
        await manager.disconnect(user_id, websocket, save_task_state=task_state)
```

### Sending Messages

```python
# Send to a specific user's all sockets
await manager.send(
    user_id="user123",
    message={
        "type": "chunk",
        "delta": "Hello world"
    },
    conversation_id="conv-123"
)

# Broadcast to all users
await manager.broadcast({
    "type": "system",
    "message": "Server maintenance in 5 minutes"
})
```

### Querying Connection State

```python
# Check if user is connected
is_online = manager.is_connected("user123")

# Get all active user IDs
active_users = manager.get_active_users()

# Get socket count for a user
socket_count = manager.get_user_connection_count("user123")

# Get statistics
stats = await manager.get_stats()
# {
#   "total_users": 42,
#   "total_sockets": 127,
#   "users": {
#     "user123": 3,
#     "user456": 1,
#     ...
#   }
# }
```

### Task State Recovery

```python
# On disconnect, save state
await manager.disconnect(
    user_id="user123",
    websocket=ws,
    save_task_state={
        "conversation_id": "conv-123",
        "messages": [...],
        "status": "in_progress",
        "tokens_used": 1234
    }
)

# On reconnect, retrieve saved state
task_state = await manager.recover_task_state("user123")
if task_state:
    # Resume from saved state
    messages = task_state["messages"]
    # ... continue processing
    
    # Clear state after successful resume
    await manager.clear_task_state("user123")
```

## Redis Keys

The ConnectionManager uses the following Redis keys for state persistence:

| Key | Purpose | TTL |
|-----|---------|-----|
| `ws:connections:{user_id}` | Set of active connection IDs | 300s (5m) |
| `ws:task_state:{user_id}` | Serialized task state for recovery | 3600s (1h) |
| `ws:reconnect:{user_id}` | Temporary reconnect data | 300s (5m) |

## Message Types Reference

### Client → Server

| Type | Payload | Description |
|------|---------|-------------|
| `query` | `messages`, `model`, `conversation_id` | New chat query to process |
| `resume` | `conversation_id` | Resume interrupted task |
| `pong` | (none) | Heartbeat response |

### Server → Client

| Type | Payload | Description |
|------|---------|-------------|
| `chunk` | `delta` | Streaming token from agent |
| `done` | `model`, `latency_ms` | Streaming complete |
| `error` | `message` | Error occurred |
| `tool_start` | `tool_name`, `args` | Tool invocation started |
| `tool_result` | `tool_name`, `output` | Tool result available |
| `routing` | `route`, `reason` | Message routing info |
| `usage_update` | `tokens_used`, `tokens_remaining` | Token usage update |
| `ping` | (none) | Heartbeat ping |
| `resume_state` | `state` | Recovered task state |

## Error Handling

### Connection Drops

```javascript
ws.addEventListener("close", (event) => {
  if (event.code === 1000) {
    // Normal closure
  } else if (event.code === 1008) {
    // Policy violation (e.g., auth failure)
    console.error("Auth failed:", event.reason);
  } else {
    // Network error or unexpected close
    console.log("Disconnected:", event.code, event.reason);
    
    // Attempt reconnect with exponential backoff
    setTimeout(() => {
      // Reconnect and send resume message
    }, 1000 * Math.pow(2, retryCount));
  }
});
```

### Timeout Handling

The ConnectionManager sends a `ping` message every 30 seconds. Clients must respond with `pong` within 10 seconds, or the connection is closed.

```javascript
let pingTimeout;

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  
  if (msg.type === "ping") {
    clearTimeout(pingTimeout);
    ws.send(JSON.stringify({ type: "pong" }));
    
    // Set timeout for next ping
    pingTimeout = setTimeout(() => {
      console.error("Heartbeat timeout - reconnecting");
      ws.close();
    }, 45000); // Expect ping within 45 seconds
  }
});
```

## Performance Considerations

1. **Connection Limits**: One user can have multiple connections (e.g., 3-5 tabs). The server memory usage scales with `connections * users`.

2. **Heartbeat Overhead**: Ping/pong messages are minimal (< 100 bytes). 30-second interval balances between responsiveness and bandwidth.

3. **State Persistence**: Task state is stored in Redis with a 1-hour TTL. For long-running tasks, periodically update the saved state or increase TTL.

4. **Broadcast**: Broadcasting to all users should be used sparingly (e.g., for announcements). For large user bases, consider segmentation (e.g., by tier, region).

## Testing

```bash
# Run tests
pytest server/test_connections.py -v

# Run with output
pytest server/test_connections.py -v -s

# Run specific test
pytest server/test_connections.py::TestConnectionManager::test_connect -v
```

## Example: Full Chat Flow

### Client (JavaScript)

```javascript
async function chat(userMessage) {
  const ws = new WebSocket(`ws://localhost:8000/ws/user123`, [], {
    headers: { "Authorization": "Bearer token123" }
  });

  let responseText = "";

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "chunk") {
      responseText += msg.delta;
      updateUI(responseText);
    } else if (msg.type === "done") {
      console.log(`Completed in ${msg.latency_ms}ms using ${msg.model}`);
    } else if (msg.type === "error") {
      console.error(msg.message);
    } else if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  });

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({
      type: "query",
      conversation_id: "conv-" + Date.now(),
      messages: [{ role: "user", content: userMessage }]
    }));
  });
}
```

### Server (Python)

```python
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from connections import ConnectionManager
from agents.code_agent import CodeAgent
from tiers import TierGuard

app = FastAPI()
manager = ConnectionManager(redis_client)
tier_guard = TierGuard(...)

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(user_id: str, websocket: WebSocket):
    await websocket.accept()
    conn_id = await manager.connect(user_id, websocket)

    try:
        while True:
            data = await websocket.receive_json()

            if data["type"] == "query":
                messages = data["messages"]
                tier = tier_guard.get_tier(user_id)
                agent = CodeAgent(tier=tier)
                
                await agent.stream(messages, websocket)

            elif data["type"] == "pong":
                # Heartbeat response
                pass

    except WebSocketDisconnect:
        await manager.disconnect(user_id, websocket)
```

## Troubleshooting

### "Redis unavailable"

```python
# Check Redis connection
redis_client = redis.from_url("redis://localhost:6379")
await redis_client.ping()  # Should print "True"
```

### Heartbeat timeout

- Ensure client responds to `ping` with `pong` within 10 seconds
- Check network latency: `ping localhost`
- Increase timeout in ConnectionManager (adjust `HEARTBEAT_TIMEOUT`)

### Task state not recovering

- Verify Redis has key: `redis-cli get ws:task_state:user123`
- Check TTL is not expired: `redis-cli ttl ws:task_state:user123`
- Ensure `save_task_state` is provided on disconnect

## Next Steps

- Integrate with client UI (React/Vue)
- Add automatic reconnection with exponential backoff
- Implement chat history persistence
- Add user presence indicators
- Monitor connection metrics
