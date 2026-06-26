"""
Unit tests for WebSocket ConnectionManager.

Tests connection lifecycle, multi-device support, message delivery, and state persistence.
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from connections import ConnectionManager, TASK_STATE_PREFIX, ACTIVE_CONVERSATIONS_PREFIX


class MockWebSocket:
    """Mock WebSocket for testing."""

    def __init__(self):
        self.messages = []
        self.accepted = False
        self.closed = False

    async def accept(self):
        self.accepted = True

    async def send_json(self, data: dict):
        if self.closed:
            raise RuntimeError("WebSocket is closed")
        self.messages.append(data)

    async def receive_json(self):
        if not self.messages:
            await asyncio.sleep(1)
        return self.messages.pop(0) if self.messages else {}


@pytest.mark.asyncio
async def test_connect_single_user():
    """Test connecting a single user."""
    manager = ConnectionManager()
    ws = MockWebSocket()

    await manager.connect("user1", ws)

    assert manager.is_connected("user1")
    assert manager.connected_users_count() == 1
    assert manager.total_connections_count() == 1
    assert ws.accepted


@pytest.mark.asyncio
async def test_multiple_connections_same_user():
    """Test multiple WebSocket connections for the same user (multiple tabs/devices)."""
    manager = ConnectionManager()
    ws1 = MockWebSocket()
    ws2 = MockWebSocket()
    ws3 = MockWebSocket()

    await manager.connect("user1", ws1)
    await manager.connect("user1", ws2)
    await manager.connect("user1", ws3)

    assert manager.is_connected("user1")
    assert manager.connected_users_count() == 1
    assert manager.total_connections_count() == 3


@pytest.mark.asyncio
async def test_disconnect():
    """Test disconnecting a user."""
    manager = ConnectionManager()
    ws1 = MockWebSocket()
    ws2 = MockWebSocket()

    await manager.connect("user1", ws1)
    await manager.connect("user1", ws2)
    await manager.disconnect("user1", ws1)

    assert manager.is_connected("user1")
    assert manager.total_connections_count() == 1

    await manager.disconnect("user1", ws2)
    assert not manager.is_connected("user1")
    assert manager.total_connections_count() == 0


@pytest.mark.asyncio
async def test_send_to_user():
    """Test sending a message to all user's connections."""
    manager = ConnectionManager()
    ws1 = MockWebSocket()
    ws2 = MockWebSocket()

    await manager.connect("user1", ws1)
    await manager.connect("user1", ws2)

    await manager.send("user1", {
        "type": "message",
        "conversation_id": "conv1",
        "content": "Hello",
    })

    # Both connections should receive the message
    assert len(ws1.messages) == 1
    assert len(ws2.messages) == 1
    assert ws1.messages[0]["type"] == "message"
    assert ws1.messages[0]["content"] == "Hello"
    assert "timestamp" in ws1.messages[0]


@pytest.mark.asyncio
async def test_broadcast():
    """Test broadcasting to all connected users."""
    manager = ConnectionManager()
    ws1 = MockWebSocket()
    ws2 = MockWebSocket()
    ws3 = MockWebSocket()

    await manager.connect("user1", ws1)
    await manager.connect("user1", ws2)
    await manager.connect("user2", ws3)

    await manager.broadcast({
        "type": "system",
        "message": "Server maintenance in 5 minutes",
    })

    # All connections should receive the message
    assert len(ws1.messages) == 1
    assert len(ws2.messages) == 1
    assert len(ws3.messages) == 1


@pytest.mark.asyncio
async def test_message_envelope():
    """Test message envelope wrapping with timestamp."""
    manager = ConnectionManager()
    ws = MockWebSocket()

    await manager.connect("user1", ws)

    await manager.send("user1", {
        "type": "reply",
        "conversation_id": "conv123",
        "content": "test",
    })

    msg = ws.messages[0]
    assert msg["type"] == "reply"
    assert msg["conversation_id"] == "conv123"
    assert msg["content"] == "test"
    assert "timestamp" in msg
    # Timestamp should be ISO format
    assert "T" in msg["timestamp"] and "Z" in msg["timestamp"]


@pytest.mark.asyncio
async def test_send_to_disconnected_user():
    """Test sending to a user with no active connections."""
    manager = ConnectionManager()

    # Should not raise, just silently skip
    await manager.send("nonexistent", {"type": "message", "content": "test"})


@pytest.mark.asyncio
async def test_task_state_persistence():
    """Test saving and loading task state from Redis."""
    # Create mock Redis client
    redis = AsyncMock()
    redis.setex = AsyncMock()
    redis.get = AsyncMock()

    manager = ConnectionManager(redis_client=redis)

    # Test saving
    task_state = {"step": 1, "data": "test"}
    await manager.save_task_state("user1", "conv1", task_state)

    # Verify Redis.setex was called with correct key format
    assert redis.setex.called
    call_args = redis.setex.call_args
    assert call_args[0][0] == f"{TASK_STATE_PREFIX}user1:conv1"
    assert json.loads(call_args[0][2]) == task_state
    assert call_args[0][1] == 7 * 24 * 60 * 60  # 7 days


@pytest.mark.asyncio
async def test_load_task_state():
    """Test loading task state from Redis."""
    redis = AsyncMock()
    task_state = {"step": 2, "data": "resumed"}
    redis.get = AsyncMock(return_value=json.dumps(task_state))

    manager = ConnectionManager(redis_client=redis)
    loaded = await manager.load_task_state("user1", "conv1")

    assert loaded == task_state
    redis.get.assert_called_once_with(f"{TASK_STATE_PREFIX}user1:conv1")


@pytest.mark.asyncio
async def test_load_task_state_not_found():
    """Test loading task state when not found."""
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)

    manager = ConnectionManager(redis_client=redis)
    loaded = await manager.load_task_state("user1", "conv1")

    assert loaded is None


@pytest.mark.asyncio
async def test_active_conversations():
    """Test tracking active conversations."""
    redis = AsyncMock()
    redis.sadd = AsyncMock()
    redis.expire = AsyncMock()
    redis.smembers = AsyncMock(return_value={"conv1", "conv2"})

    manager = ConnectionManager(redis_client=redis)

    # Mark conversations active
    await manager.mark_conversation_active("user1", "conv1")
    await manager.mark_conversation_active("user1", "conv2")

    assert redis.sadd.call_count == 2

    # Get active conversations
    convs = await manager.get_active_conversations("user1")
    assert "conv1" in convs
    assert "conv2" in convs


@pytest.mark.asyncio
async def test_no_redis_graceful_degradation():
    """Test that manager works without Redis (no state persistence)."""
    manager = ConnectionManager(redis_client=None)
    ws = MockWebSocket()

    await manager.connect("user1", ws)

    # Should still be able to send messages
    await manager.send("user1", {"type": "message", "content": "test"})
    assert len(ws.messages) == 1

    # State persistence should be skipped silently
    await manager.save_task_state("user1", "conv1", {"data": "test"})
    loaded = await manager.load_task_state("user1", "conv1")
    assert loaded is None


@pytest.mark.asyncio
async def test_connection_count_metrics():
    """Test connection count metrics."""
    manager = ConnectionManager()

    assert manager.connected_users_count() == 0
    assert manager.total_connections_count() == 0

    # Add some users
    for i in range(3):
        for j in range(i + 1):
            ws = MockWebSocket()
            await manager.connect(f"user{i}", ws)

    assert manager.connected_users_count() == 3
    # user0: 1, user1: 2, user2: 3 = 6 total
    assert manager.total_connections_count() == 6


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
