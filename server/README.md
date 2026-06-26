# OpenUI Tier Enforcement Server

Server-side subscription tier enforcement, task queue prioritization, and Stripe webhook handling for OpenUI.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Electron App (Renderer)                                     │
│ - Tier-gated UI (can't show Pro buttons without Pro tier)   │
│ - Enqueues tasks (chat, vision, etc.) to /queue/enqueue     │
└────────────────────────────┬────────────────────────────────┘
                             │ IPC / HTTP
┌─────────────────────────────▼────────────────────────────────┐
│ Tier Enforcement Server (Flask)                              │
├─────────────────────────────────────────────────────────────┤
│ TierGuard (tiers.py)                                         │
│ - Fetch tier from Supabase on login                         │
│ - Cache in Redis (1hr TTL)                                  │
│ - Check permissions (action, model, browser tabs)           │
│ - Enforce daily limits (chat, voice)                        │
│                                                             │
│ PriorityQueue (queue.py)                                     │
│ - Enqueue tasks with tier-based priority                    │
│ - Pro/Enterprise jump Free users                           │
│ - Enterprise has dedicated slot (never queued)              │
│ - Dequeue for execution                                      │
│                                                             │
│ Stripe Webhook Handler (stripe_webhook.py)                  │
│ - Verify Stripe signature                                   │
│ - Update tier on subscription change                        │
│ - Invalidate Redis cache                                     │
└────────────────┬───────────────────────────┬────────────────┘
                 │                           │
         Redis Cache            Supabase + Stripe
       (tier, tasks)          (authoritative)
```

## Setup

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Environment Variables

Create a `.env` file (or set in production):

```bash
# Redis (optional, server will run without Redis but without caching)
REDIS_URL=redis://localhost:6379

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SIGNING_SECRET=whsec_...
STRIPE_PRO_PRICE_ID=price_...
STRIPE_ENTERPRISE_PRICE_ID=price_...

# Server
DEBUG=false
PORT=5000
```

### 3. Start Redis (optional but recommended)

```bash
# macOS (via Homebrew)
brew services start redis

# Docker
docker run -d -p 6379:6379 redis:latest

# Windows (via WSL or Docker Desktop)
wsl redis-server
```

### 4. Run the Server

```bash
python app.py
```

Or with gunicorn (production):

```bash
gunicorn -w 4 -b 0.0.0.0:5000 app:app
```

## API Endpoints

### Tier Information

#### `GET /tiers`

List all tier definitions.

**Response:**
```json
{
  "free": {
    "name": "Free",
    "price_usd": 0,
    "daily_chat_limit": 20,
    "daily_voice_limit": 20,
    "models": {
      "cloud": ["claude-3-5-haiku"],
      "local": ["llama3:8b", "phi3:mini"]
    },
    "max_browser_tabs": 1,
    "has_terminal": false,
    "has_ppt_excel": false,
    "has_email": false,
    "priority_queue": false,
    "dedicated_slot": false
  },
  ...
}
```

#### `GET /user/<user_id>/tier`

Get a user's current subscription tier.

**Headers:**
```
Authorization: Bearer <supabase-jwt>
```

**Response:**
```json
{
  "user_id": "...",
  "tier": "pro",
  "tier_name": "Pro",
  "tier_price_usd": 19
}
```

### Permission Checking

#### `POST /user/<user_id>/check-permission`

Check if user has permission for an action.

**Headers:**
```
Authorization: Bearer <supabase-jwt>
Content-Type: application/json
```

**Request:**
```json
{
  "action": "use_gpt4o"  // or use_ppt, use_terminal, use_email, use_github, use_figma
}
```

**Success (200):**
```json
{
  "allowed": true,
  "user_id": "...",
  "action": "use_gpt4o"
}
```

**Denied (403):**
```json
{
  "error": "GPT-4o requires Pro subscription",
  "allowed_from": "pro",
  "upgrade_url": "https://openui.com/pricing"
}
```

#### `POST /user/<user_id>/check-browser-tabs`

Check if user can open N browser tabs.

**Request:**
```json
{
  "num_tabs": 5
}
```

**Denied (403):**
```json
{
  "error": "Browser tab limit is 1 for Free tier",
  "allowed_from": "pro",
  "upgrade_url": "https://openui.com/pricing"
}
```

#### `POST /user/<user_id>/check-model`

Check if user can use a specific model.

**Request:**
```json
{
  "model": "gpt-4o"
}
```

**Denied (403):**
```json
{
  "allowed": false,
  "user_id": "...",
  "model": "gpt-4o",
  "current_tier": "free",
  "error": "Model gpt-4o not available for free tier"
}
```

### Task Queue

#### `POST /queue/enqueue`

Add a task to the priority queue.

**Request:**
```json
{
  "user_id": "...",
  "action": "chat",
  "data": {
    "message": "...",
    "model": "claude-3-5-sonnet"
  }
}
```

**Response (201):**
```json
{
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "user_id": "...",
  "action": "chat"
}
```

#### `GET /queue/status`

Get current queue status.

**Response:**
```json
{
  "queue_size": 15,
  "executing": 2,
  "has_enterprise_slot": true,
  "by_tier": {
    "free": 10,
    "pro": 5
  }
}
```

#### `GET /queue/task/<task_id>`

Get status of a specific task.

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "user_id": "...",
  "tier": "pro",
  "action": "chat",
  "priority": "normal",
  "created_at": 1719432000.5,
  "started_at": 1719432010.2,
  "data": {...}
}
```

### Stripe Webhooks

#### `POST /webhooks/stripe`

Stripe webhook endpoint. Listens for subscription events.

**No authentication required** — signature verified via STRIPE_WEBHOOK_SIGNING_SECRET.

**Events handled:**
- `checkout.session.completed` — User completed purchase
- `customer.subscription.created` — New subscription
- `customer.subscription.updated` — Tier or price changed
- `customer.subscription.deleted` — Subscription canceled (downgrade to Free)

### Health

#### `GET /health`

Health check.

**Response:**
```json
{
  "status": "ok"
}
```

#### `GET /info`

Server info.

**Response:**
```json
{
  "name": "OpenUI Tier Enforcement Server",
  "version": "1.0.0",
  "features": ["tier-guard", "priority-queue", "stripe-webhooks"],
  "redis_available": true,
  "queue_available": true
}
```

## Integration with Electron App

### 1. Fetch User Tier on Login

After Supabase OAuth completes:

```typescript
const response = await fetch(`http://localhost:5000/user/${userId}/tier`, {
  headers: { Authorization: `Bearer ${supabaseToken}` }
});
const { tier } = await response.json();
// Update UI based on tier
```

### 2. Check Permissions Before Action

Before using Pro/Enterprise features:

```typescript
try {
  await fetch(`http://localhost:5000/user/${userId}/check-permission`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supabaseToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action: "use_gpt4o" })
  });
  // OK to use GPT-4o
} catch (err) {
  // Show upgrade modal
}
```

### 3. Enqueue Tasks with Priority

When user sends a message/initiates an action:

```typescript
const response = await fetch(`http://localhost:5000/queue/enqueue`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${supabaseToken}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    user_id: userId,
    action: "chat",
    data: { message, model, ... }
  })
});
const { task_id } = await response.json();
// Poll /queue/task/<task_id> for status
```

## Deployment

### Heroku

```bash
# Create Heroku app
heroku create openui-tier-server

# Set environment variables
heroku config:set REDIS_URL=redis://...
heroku config:set SUPABASE_URL=...
heroku config:set STRIPE_SECRET_KEY=...
# ... etc

# Deploy
git push heroku main
```

### Docker

```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY server/ .

CMD ["gunicorn", "-w", "4", "-b", "0.0.0.0:5000", "app:app"]
```

### AWS Lambda (with Zappa)

```bash
pip install zappa
zappa init
zappa deploy production
```

## Monitoring

### Queue Backlog

Monitor queue depth via `/queue/status`:

```bash
watch -n 2 'curl http://localhost:5000/queue/status | jq'
```

### Tier Syncing

The server caches tiers in Redis for 1 hour. To force a refresh:

```bash
redis-cli DEL tier:user-id
```

### Stripe Events

Check Redis for recent Stripe webhook events:

```bash
redis-cli HGETALL enterprise:slot
redis-cli ZRANGE pending:queue 0 -1
```

## Troubleshooting

### Redis Connection Failed

If Redis is unavailable, the server will:
- Still work for tier enforcement (no caching, slower Supabase calls)
- Disable task queue (priority_queue = None)
- Use in-memory caching (not persistent across restarts)

Fix:
```bash
redis-cli ping  # Check if Redis is running
redis-cli INFO  # Get Redis stats
```

### Stripe Webhooks Not Received

1. Check webhook signing secret matches `STRIPE_WEBHOOK_SIGNING_SECRET`
2. Verify endpoint URL is reachable from Stripe
3. Check server logs for signature verification errors
4. Stripe Dashboard → Webhooks → View Events → Check delivery status

### Tier Not Updating After Purchase

1. Check Supabase user `app_metadata.tier` was updated:
   ```sql
   SELECT * FROM auth.users WHERE id = '...' LIMIT 1;
   ```
2. Invalidate Redis cache: `redis-cli DEL tier:user-id`
3. Verify Stripe webhook secret is correct
4. Check server logs for webhook processing errors

## Security

- **JWT tokens**: All tier-checking endpoints require Bearer token (validated by Flask/Supabase)
- **Stripe signature**: Webhook endpoint verifies Stripe-Signature header
- **Rate limiting**: Add Flask-Limiter for production (not included in basic setup)
- **Redis auth**: Use requirepass or network isolation for production Redis
- **HTTPS**: Use HTTPS in production (enforce via load balancer/Cloudflare)

## Performance

- **Tier lookup**: O(1) Redis cache hit, O(n) Supabase call on miss (cache TTL = 1hr)
- **Queue dequeue**: O(log n) sorted set operation
- **Webhook processing**: Async (fire-and-forget), < 100ms typical

For high throughput, consider:
- Redis clustering
- Separate Stripe webhook worker (queue-based processing)
- Database replication (Supabase)
