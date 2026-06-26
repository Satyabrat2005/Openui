# Quick Start: OpenUI Tier Enforcement Server

Get the server running in 5 minutes for local development.

## Prerequisites

- Python 3.10+ (`python --version`)
- pip (`pip --version`)
- Redis (optional but recommended)

## Installation

### 1. Create Virtual Environment

```bash
cd server
python -m venv venv

# Activate (macOS/Linux)
source venv/bin/activate

# Activate (Windows PowerShell)
.\venv\Scripts\Activate.ps1
```

### 2. Install Dependencies

```bash
pip install -r requirements.txt
```

### 3. Set Up Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` to add your credentials:

```bash
# Minimal setup (tier checking only, no Redis/Webhooks)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Optional: Add Stripe for webhooks
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SIGNING_SECRET=whsec_test_...
```

### 4. Start Redis (Optional but Recommended)

```bash
# macOS (Homebrew)
brew services start redis

# Docker
docker run -d -p 6379:6379 redis:latest

# Or skip for in-memory cache (slower, but works)
```

## Running the Server

### Development Mode

```bash
python app.py
```

You should see:

```
[App] Starting OpenUI Tier Enforcement Server (debug=true, port=5000)
[App] Redis available: True
[App] Queue available: True
 * Running on http://0.0.0.0:5000
```

### Test the Server

In another terminal:

```bash
# Check health
curl http://localhost:5000/health

# Get all tiers
curl http://localhost:5000/tiers | jq

# Check user tier (requires token)
curl -H "Authorization: Bearer test-token" \
  http://localhost:5000/user/test-user/tier
```

## Running Tests

```bash
# Install test dependencies
pip install pytest fakeredis

# Run tests
pytest test_tiers.py -v

# Run with coverage
pytest test_tiers.py --cov=. --cov-report=html
```

## Common Issues

### `ModuleNotFoundError: No module named 'redis'`

Install dependencies:

```bash
pip install -r requirements.txt
```

### `ConnectionRefusedError: [Errno 111] Connection refused` (Redis)

Redis is optional. The server will work without it but without caching:

```bash
# Option 1: Start Redis
redis-server

# Option 2: Continue without Redis (it will warn but work)
```

### `SUPABASE_URL not set`

The server needs Supabase for tier syncing. Set in `.env`:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

Or skip tier syncing for development by testing with tier override:

```bash
# In Python:
from tiers import TierGuard, TierId
guard = TierGuard()
guard.check_permission("user-1", "use_gpt4o", tier_override=TierId.PRO)
```

## Next Steps

### 1. Connect from Electron App

Set `TIER_SERVER_URL` in the Electron app `.env`:

```bash
TIER_SERVER_URL=http://localhost:5000
```

Then integrate as described in [INTEGRATION.md](./INTEGRATION.md).

### 2. Test Permission Checking

```bash
# Check permission (should fail for Free tier)
curl -X POST http://localhost:5000/user/test-user/check-permission \
  -H "Authorization: Bearer test-token" \
  -H "Content-Type: application/json" \
  -d '{"action": "use_terminal"}'

# Response:
# {
#   "error": "Terminal access requires Enterprise subscription",
#   "allowed_from": "enterprise",
#   "upgrade_url": "https://openui.com/pricing"
# }
```

### 3. Test Queue

```bash
# Enqueue a task
curl -X POST http://localhost:5000/queue/enqueue \
  -H "Authorization: Bearer test-token" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "test-user",
    "action": "chat",
    "data": {"message": "Hello"}
  }'

# Check queue status
curl http://localhost:5000/queue/status | jq
```

### 4. Set Up Stripe Webhooks (Optional)

If you want to test Stripe webhooks:

1. Get your webhook signing secret from Stripe Dashboard
2. Add to `.env`:
   ```bash
   STRIPE_WEBHOOK_SIGNING_SECRET=whsec_...
   STRIPE_SECRET_KEY=sk_...
   ```
3. Use Stripe CLI to forward events:
   ```bash
   stripe listen --forward-to localhost:5000/webhooks/stripe
   stripe trigger customer.subscription.updated
   ```

## Production Deployment

### Heroku

```bash
# Create app
heroku create openui-tier-server

# Set environment variables
heroku config:set SUPABASE_URL=... STRIPE_SECRET_KEY=...

# Deploy
git push heroku main

# Check logs
heroku logs --tail
```

### Docker

```bash
docker build -t openui-tier-server .
docker run -p 5000:5000 \
  -e SUPABASE_URL=... \
  -e REDIS_URL=redis://redis:6379 \
  openui-tier-server
```

### Environment Variables for Production

Before deploying, set these in your production environment:

```bash
DEBUG=false
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...  # Keep secret!
STRIPE_SECRET_KEY=sk_live_...  # Keep secret!
STRIPE_WEBHOOK_SIGNING_SECRET=whsec_...
REDIS_URL=redis://...
```

## File Structure

```
server/
├── __init__.py              # Package initialization
├── tiers.py                 # TierGuard class
├── stripe_webhook.py        # Stripe webhook handler
├── queue.py                 # Priority queue
├── app.py                   # Flask server
├── test_tiers.py            # Unit tests
├── requirements.txt         # Python dependencies
├── .env.example             # Environment template
├── .env                     # Your environment (git-ignored)
├── README.md                # Full documentation
├── INTEGRATION.md           # Integration with Electron app
└── QUICKSTART.md            # This file
```

## API Endpoints at a Glance

```
GET  /health                                    Health check
GET  /tiers                                     List all tier definitions
GET  /user/<user_id>/tier                       Get user's tier
POST /user/<user_id>/check-permission           Check action permission
POST /user/<user_id>/check-browser-tabs         Check tab limit
POST /user/<user_id>/check-model                Check model access
POST /queue/enqueue                             Add task to queue
GET  /queue/status                              Queue status
GET  /queue/task/<task_id>                      Task status
POST /webhooks/stripe                           Stripe webhook
```

See [README.md](./README.md) for full API documentation.

## Debugging Tips

### Check Tier from Redis

```bash
redis-cli GET tier:user-123
# Returns: "pro"
```

### View Queue

```bash
redis-cli ZRANGE pending:queue 0 -1
# Shows task IDs in priority order
```

### Check Server Logs

```bash
# Terminal where server is running
# Look for [TierGuard], [Queue], [Stripe] prefixes
```

### Test from Python

```python
from tiers import TierGuard, TierId

guard = TierGuard()
try:
    guard.check_permission("user-1", "use_terminal", tier_override=TierId.FREE)
except Exception as e:
    print(f"Permission denied: {e}")
    print(f"Allowed from: {e.allowed_from}")
```

## Need Help?

- Check server is running: `curl http://localhost:5000/health`
- Review logs in the terminal where `python app.py` runs
- Read [README.md](./README.md) for detailed documentation
- Check [INTEGRATION.md](./INTEGRATION.md) for Electron app integration

---

**Next:** [Integrate with Electron App →](./INTEGRATION.md)
