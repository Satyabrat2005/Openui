# Task 8: WebSocket Connection Manager — Complete Example

This document shows a real-world usage example of the `ConnectionManager` with disconnect/reconnect flow.

## Scenario: Multi-Tab Chat with Disconnect Recovery

A user has two browser tabs open, both connected via WebSocket. The user asks the AI a question in Tab 1, but the network drops briefly. The system saves the task state, the user reconnects with Tab 2, and resumes the conversation seamlessly.

### Step 1: Initial Connection (Both Tabs)

**Tab 1 connects:**
```python
# WebSocket handler in main.py
await manager.connect("user_alice", websocket_tab1)
# Logs: WS connected: user=user_alice index=0 (total=1)
```

**Tab 2 connects:**
```python
await manager.connect("user_alice", websocket_tab2)
# Logs: WS connected: user=user_alice index=1 (total=2)
```

State:
```
_connections = {
  "user_alice": [websocket_tab1, websocket_tab2]
}
```

### Step 2: User Sends a Message (Tab 1)

**Tab 1 sends a query:**
```json
{
  "type": "message",
  "conversation_id": "conv_a1b2c3d4",
  "message": "What's the capital of France?",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

**Server receives and processes:**
```python
# In ws_endpoint
msg_type = data.get("type", "message")  # "message"
conversation_id = data.get("conversation_id")  # "conv_a1b2c3d4"

# Mark conversation as active for resumption tracking
await manager.mark_conversation_active("user_alice", "conv_a1b2c3d4")

# Save initial task state to Redis
await manager.save_task_state("user_alice", "conv_a1b2c3d4", {
    "status": "processing",
    "user_message": "What's the capital of France?",
    "tokens_generated": 0,
    "conversation_id": "conv_a1b2c3d4",
})
```

Redis now has:
```
task_state:user_alice:conv_a1b2c3d4 → {"status":"processing", ...}
active_convs:user_alice → ["conv_a1b2c3d4"]
```

### Step 3: Task Processing (Streaming Responses)

**Server streams tokens to both tabs:**
```python
# Token 1: "Paris"
await manager.send("user_alice", {
    "type": "chunk",
    "conversation_id": "conv_a1b2c3d4",
    "token": "Paris",
    "tokens_generated": 1,
})
# Both websocket_tab1 and websocket_tab2 receive this message

# Token 2: " is"
await manager.send("user_alice", {
    "type": "chunk",
    "conversation_id": "conv_a1b2c3d4",
    "token": " is",
    "tokens_generated": 2,
})

# Update task state after each token
await manager.save_task_state("user_alice", "conv_a1b2c3d4", {
    "status": "streaming",
    "user_message": "What's the capital of France?",
    "tokens_generated": 2,
    "partial_response": "Paris is",
})
```

Both tabs see: "Paris is" (streaming)

### Step 4: Network Disconnects (Tab 1 Dies)

**Network interruption — websocket_tab1 closes:**
```python
# Exception in ws_endpoint
except WebSocketDisconnect:
    await manager.disconnect("user_alice", websocket_tab1)
    # Logs: WS disconnected: user=user_alice index=0 (remaining=1)
```

State after disconnect:
```
_connections = {
  "user_alice": [websocket_tab2]  # Only Tab 2 remains
}
```

Important: Task state is already saved to Redis, so it's not lost:
```
task_state:user_alice:conv_a1b2c3d4 → {"status":"streaming", "partial_response":"Paris is", ...}
```

**Tab 1 (browser) shows**: "Connection lost. Reconnecting..."
**Tab 2 continues**: Can still receive messages

### Step 5: Server Continues Processing

Even though Tab 1 is disconnected, the server continues:
```python
# Token 3: " the"
await manager.send("user_alice", {
    "type": "chunk",
    "conversation_id": "conv_a1b2c3d4",
    "token": " the",
    "tokens_generated": 3,
})
# Only Tab 2 receives this (Tab 1 is disconnected)
```

Tab 2 sees: "Paris is the" (streaming)

### Step 6: Server Completes Response

```python
# Final message
await manager.send("user_alice", {
    "type": "done",
    "conversation_id": "conv_a1b2c3d4",
    "response": "Paris is the capital of France.",
    "tokens_generated": 7,
})

# Save final task state
await manager.save_task_state("user_alice", "conv_a1b2c3d4", {
    "status": "completed",
    "user_message": "What's the capital of France?",
    "response": "Paris is the capital of France.",
    "tokens_generated": 7,
    "timestamp": "2024-01-15T10:30:05Z",
})
```

Tab 2 receives complete response: "Paris is the capital of France."

### Step 7: Tab 1 Reconnects

**User closes Tab 1 and opens a new tab, still as same browser/user:**
```python
# New WebSocket connection for same user
await manager.connect("user_alice", websocket_tab3)
# Logs: WS connected: user=user_alice index=1 (total=2)
```

State:
```
_connections = {
  "user_alice": [websocket_tab2, websocket_tab3]  # Both active now
}
```

### Step 8: Client Resumes from Saved State

**Tab 3 (new browser tab) loads and queries:**
```python
# Frontend detects user_id "user_alice" and checks for unfinished conversations
await manager.get_active_conversations("user_alice")
# Returns: {"conv_a1b2c3d4"}

# Check if this conversation has saved state
saved_state = await manager.load_task_state("user_alice", "conv_a1b2c3d4")
# Returns: {
#   "status": "completed",
#   "response": "Paris is the capital of France.",
#   "tokens_generated": 7,
# }

# Frontend shows "Recovered conversation: Paris is the capital of France."
# And asks user: "Continue?" or "Start new?"
```

### Step 9: Heartbeat Monitoring

**Continuous background heartbeat (every 30 seconds):**

For websocket_tab2 and websocket_tab3:
```python
# Heartbeat task for Tab 2
await websocket_tab2.send_json({"type": "ping"})
# Tab 2 responds with: {"type": "pong"}
# Connection remains healthy

# Heartbeat task for Tab 3
await websocket_tab3.send_json({"type": "ping"})
# Tab 3 responds with: {"type": "pong"}
# Connection remains healthy
```

If a tab becomes unresponsive:
```python
# Ping sent but Tab X doesn't respond
await websocket_tabX.send_json({"type": "ping"})
# Exception: connection closed
# Automatically call:
await manager.disconnect("user_alice", websocket_tabX)
# Logs: Heartbeat error (disconnecting): user=user_alice index=...
```

### Step 10: Send Message from Tab 3 (Resumed Conversation)

**Tab 3 asks a follow-up question:**
```json
{
  "type": "message",
  "conversation_id": "conv_e5f6g7h8",
  "message": "What language do they speak there?",
  "timestamp": "2024-01-15T10:31:00Z"
}
```

```python
# Mark new conversation active
await manager.mark_conversation_active("user_alice", "conv_e5f6g7h8")

# Server responds, both Tab 2 and Tab 3 receive:
await manager.send("user_alice", {
    "type": "reply",
    "conversation_id": "conv_e5f6g7h8",
    "content": "French is the primary language spoken in France.",
})
```

Both tabs see the response.

## Key Insights

### Multi-Device Support
- User can have 2+ tabs/devices simultaneously
- Each gets the same server-sent messages (via `manager.send()`)
- One tab can disconnect without affecting others

### State Persistence
- Task state saved to Redis on every important update
- If all tabs disconnect, state remains recoverable for 7 days
- On reconnect, client checks active conversations and resumes

### Message Envelope
- All messages follow consistent format: `type`, `conversation_id`, `timestamp`
- Makes routing and state tracking deterministic
- Supports streaming (`chunk`), completion (`done`), and errors

### Heartbeat Reliability
- Ping sent every 30s, no pong required (connection health checked via send)
- Stale connections auto-cleaned up by heartbeat monitor
- Reduces wasted resources on dead connections

## Health Check Response

```bash
GET /health
```

```json
{
  "status": "ok",
  "version": "0.2.0",
  "ollama_connected": true,
  "redis_connected": true,
  "ws_users": 3,
  "ws_connections": 5
}
```

Metrics:
- `ws_users`: 3 (Alice, Bob, Charlie)
- `ws_connections`: 5 (Alice: 2 tabs, Bob: 2 tabs, Charlie: 1 tab)

## Redis State Inspection

```bash
# Check active conversations for Alice
SMEMBERS active_convs:user_alice
# Output: ["conv_a1b2c3d4", "conv_e5f6g7h8"]

# Check saved state for a conversation
GET task_state:user_alice:conv_a1b2c3d4
# Output: {"status":"completed","response":"Paris is...","tokens_generated":7}

# Cleanup (automatic 7-day TTL)
TTL task_state:user_alice:conv_a1b2c3d4
# Output: 604789 (seconds remaining)
```

## Broadcasting Example

**Server maintenance alert:**
```python
await manager.broadcast({
    "type": "routing",
    "message": "Server maintenance starts in 5 minutes. Please save your work.",
})

# ALL users (Alice's 2 tabs, Bob's 2 tabs, Charlie's 1 tab) receive this
```

## Error Handling

### What happens if Redis is unavailable?

```python
# ConnectionManager initialized with redis_client=None
manager = ConnectionManager(redis_client=None)

# All connection management still works:
await manager.connect(...)  # ✓ Works
await manager.send(...)     # ✓ Works
await manager.broadcast()   # ✓ Works

# But state persistence is skipped:
await manager.save_task_state(...)  # Logs: "Redis not available; skipping..."
await manager.load_task_state(...)  # Returns None
```

Users can still connect and chat, they just can't resume after total disconnect.

### What if a send() fails?

```python
# Tab 2 is dead but still in the list
await manager.send("user_alice", {"type": "chunk", "token": "test"})

# Internal behavior:
# 1. Try to send to Tab 2 → Exception
# 2. Log error: "Failed to send to user=user_alice index=1: ..."
# 3. Auto-disconnect Tab 2
# 4. Send to Tab 3 → Success
# User doesn't see the failure, just experiences one tab auto-closing
```

## Next Steps (Task 2)

After ConnectionManager is solid, Task 2 implements the routing layer:

```python
# Replace echo with real agent
await manager.send(user_id, {
    "type": "reply",
    "conversation_id": conversation_id,
    "content": f"[echo] {message}",  # ← Task 2: Route through SessionManager → TaskRouter → Agent
})
```

This ConnectionManager provides the transport layer; Task 2 provides the logic layer.
