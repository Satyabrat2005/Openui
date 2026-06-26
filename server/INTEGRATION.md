# Integration Guide: Electron App ↔ Tier Enforcement Server

This guide explains how to integrate the OpenUI Tier Enforcement Server with the Electron application.

## Architecture Overview

```
Electron App (src/main/*)
    ├─ sessionManager.ts — Auth + tier sync
    ├─ agent.ts — LLM agent (check permissions before calling models)
    ├─ tools.ts — OS tools (check permissions before browser/terminal)
    └─ IPC handlers — Permission checks before allowing actions
         │
         └─→ HTTP requests to Tier Server
                 ├─ GET /user/{id}/tier → Current tier
                 ├─ POST /user/{id}/check-permission → Action allowed?
                 ├─ POST /user/{id}/check-model → Model allowed?
                 └─ POST /queue/enqueue → Queue task for execution
```

## Step 1: Initialize Tier Guard on Login

When the user completes OAuth login, fetch their tier from the server.

### In `src/main/auth/sessionManager.ts`:

Add tier syncing after OAuth completes:

```typescript
import { syncSubscriptionStatus } from './subscriptionSync'

export async function handleOAuthSuccess(userId: string, token: string): Promise<void> {
  // ... existing auth setup ...

  // Sync tier from Supabase (existing)
  await syncSubscriptionStatus(userId)

  // Also sync with tier server (new)
  try {
    const tier = await fetchUserTierFromServer(userId, token)
    console.log(`[Auth] User ${userId} tier: ${tier}`)
    // UI will read this via IPC
  } catch (err) {
    console.error('[Auth] Failed to fetch tier from server:', err)
    // Fall back to local tier (from Supabase cache)
  }
}

async function fetchUserTierFromServer(userId: string, token: string): Promise<string> {
  const response = await fetch(`${TIER_SERVER_URL}/user/${userId}/tier`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!response.ok) throw new Error(`Tier server: ${response.status}`)
  const { tier } = await response.json()
  return tier
}
```

Define `TIER_SERVER_URL`:

```typescript
const TIER_SERVER_URL = process.env.TIER_SERVER_URL || 'http://localhost:5000'
```

## Step 2: Check Permissions Before Actions

Before using Pro/Enterprise features, call the server to verify permission.

### In `src/main/agent.ts` (before selecting models):

```typescript
import { clampTierToEntitlement } from './stripe/pricing'

async function checkModelPermission(userId: string, model: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(
      `${TIER_SERVER_URL}/user/${userId}/check-model`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model })
      }
    )

    if (response.ok) {
      return true // Model is allowed
    }

    const error = await response.json()
    console.warn(`[Agent] Model ${model} not allowed:`, error)
    return false // Model denied
  } catch (err) {
    console.error('[Agent] Permission check failed:', err)
    return false // Assume denied on error
  }
}

async function handleChatRequest(
  userId: string,
  requestedModel: string,
  token: string,
  ...args
): Promise<void> {
  // Check if model is allowed for user's tier
  const allowed = await checkModelPermission(userId, requestedModel, token)
  if (!allowed) {
    throw new Error(`Model ${requestedModel} not available for your tier`)
  }

  // Proceed with agent call
  // ...
}
```

### In `src/main/tools.ts` (for browser/terminal access):

```typescript
async function checkActionPermission(
  userId: string,
  action: string,
  token: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `${TIER_SERVER_URL}/user/${userId}/check-permission`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action })
      }
    )

    return response.ok
  } catch (err) {
    console.error(`[Tools] Permission check failed for ${action}:`, err)
    return false
  }
}

export async function openBrowserTab(
  userId: string,
  token: string,
  url: string
): Promise<void> {
  // Check permission
  const allowed = await checkActionPermission(userId, 'use_browser', token)
  if (!allowed) {
    throw new Error('Browser tool not available for your tier')
  }

  // Check tab limit
  const numTabs = await getCurrentBrowserTabCount()
  try {
    await fetch(
      `${TIER_SERVER_URL}/user/${userId}/check-browser-tabs`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ num_tabs: numTabs + 1 })
      }
    )
  } catch (err) {
    throw new Error('Browser tab limit exceeded for your tier')
  }

  // Proceed with opening tab
  // ...
}

export async function openTerminal(
  userId: string,
  token: string,
  ...args
): Promise<void> {
  // Terminal requires Enterprise
  const allowed = await checkActionPermission(userId, 'use_terminal', token)
  if (!allowed) {
    throw new Error('Terminal access requires Enterprise subscription')
  }

  // Proceed with terminal
  // ...
}
```

## Step 3: Enqueue Tasks with Priority

When processing user requests, enqueue to the priority queue.

### In `src/main/agent.ts` (when handling chat/vision/etc.):

```typescript
async function enqueueTask(
  userId: string,
  action: string,
  data: object,
  token: string
): Promise<string> {
  try {
    const response = await fetch(`${TIER_SERVER_URL}/queue/enqueue`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ user_id: userId, action, data })
    })

    if (!response.ok) throw new Error(`Queue: ${response.status}`)
    const { task_id } = await response.json()
    return task_id
  } catch (err) {
    console.error('[Agent] Failed to enqueue task:', err)
    throw err
  }
}

async function handleUserMessage(
  userId: string,
  message: string,
  token: string
): Promise<void> {
  // Enqueue the chat task
  const taskId = await enqueueTask(userId, 'chat', { message }, token)

  // Send task_id to renderer (for UI progress tracking)
  mainWindow?.webContents.send('openui:task-enqueued', { task_id: taskId })

  // Poll for completion (or use real-time updates)
  const result = await waitForTaskCompletion(taskId, token)
  mainWindow?.webContents.send('openui:task-completed', { task_id: taskId, result })
}

async function waitForTaskCompletion(
  taskId: string,
  token: string,
  timeout: number = 120000
): Promise<any> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(
        `${TIER_SERVER_URL}/queue/task/${taskId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const task = await response.json()

      if (task.completed_at) {
        return task.result // Task done
      }

      // Still pending, wait a bit
      await new Promise(resolve => setTimeout(resolve, 500))
    } catch (err) {
      console.error('[Agent] Failed to check task status:', err)
      throw err
    }
  }

  throw new Error(`Task ${taskId} timed out`)
}
```

## Step 4: Handle Permission Errors in UI

When the server denies access, show an upgrade modal.

### In `src/renderer/src/components/AssistantPopup.tsx`:

```typescript
import { TierUpgradeModal } from './TierUpgradeModal'

export function AssistantPopup(): JSX.Element {
  const [showUpgrade, setShowUpgrade] = useState(false)
  const [upgradeMessage, setUpgradeMessage] = useState('')

  // ... existing code ...

  async function handleCheckPermission(action: string): Promise<boolean> {
    try {
      const response = await fetch(
        `http://localhost:5000/user/${userId}/check-permission`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ action })
        }
      )

      if (!response.ok) {
        const error = await response.json()
        setUpgradeMessage(
          `${error.error} (available from ${error.allowed_from} tier)`
        )
        setShowUpgrade(true)
        return false
      }

      return true
    } catch (err) {
      console.error('Permission check failed:', err)
      return false
    }
  }

  return (
    <>
      {/* ... existing UI ... */}
      {showUpgrade && (
        <TierUpgradeModal
          message={upgradeMessage}
          onClose={() => setShowUpgrade(false)}
        />
      )}
    </>
  )
}
```

## Step 5: Update Tier on Stripe Events

When Stripe webhook updates the tier, invalidate local cache.

### In `src/main/stripe/subscriptionSync.ts`:

The Tier Server automatically updates tiers via Stripe webhooks. No additional code needed in the Electron app — the server handles it.

But you can optionally force a refresh when needed:

```typescript
export async function forceRefreshTier(userId: string, token: string): Promise<void> {
  try {
    await fetch(`${TIER_SERVER_URL}/user/${userId}/tier`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    // Tier is now fresh (Redis cache invalidated by webhook)
  } catch (err) {
    console.error('[Subscription] Tier refresh failed:', err)
  }
}
```

## Step 6: Environment Configuration

Add `TIER_SERVER_URL` to `.env`:

```bash
# .env (Electron app)
TIER_SERVER_URL=http://localhost:5000  # Development
# TIER_SERVER_URL=https://tier.openui.com  # Production
```

In main process (`src/main/index.ts`):

```typescript
const TIER_SERVER_URL = process.env.TIER_SERVER_URL || 'http://localhost:5000'
```

## Step 7: IPC Handlers for Renderer

Expose permission checking to the renderer over IPC:

### In `src/main/index.ts` (new IPC handler):

```typescript
ipcMain.handle('openui:check-permission', async (event, action: string) => {
  try {
    const userId = getCurrentUserId()
    const token = getActiveToken()
    if (!userId || !token) return false

    const response = await fetch(
      `${TIER_SERVER_URL}/user/${userId}/check-permission`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action })
      }
    )

    return response.ok
  } catch (err) {
    console.error('[IPC] Permission check failed:', err)
    return false
  }
})

ipcMain.handle('openui:get-user-tier', async (event) => {
  try {
    const userId = getCurrentUserId()
    const token = getActiveToken()
    if (!userId || !token) return 'free'

    const response = await fetch(
      `${TIER_SERVER_URL}/user/${userId}/tier`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    )

    if (!response.ok) return 'free'
    const { tier } = await response.json()
    return tier
  } catch (err) {
    console.error('[IPC] Tier fetch failed:', err)
    return 'free'
  }
})
```

### In `src/renderer/src/App.tsx` (use IPC):

```typescript
const userTier = await window.openui.invoke('openui:get-user-tier')
const canUseGPT4 = await window.openui.invoke('openui:check-permission', 'use_gpt4o')

if (!canUseGPT4) {
  // Show "Upgrade to Pro" button
}
```

## Error Handling Strategy

### Permission Denied (403)

Show upgrade modal with pricing info:

```typescript
catch (err) {
  if (err.response?.status === 403) {
    const error = await err.response.json()
    showUpgradeModal({
      action: action,
      required_tier: error.allowed_from,
      upgrade_url: error.upgrade_url
    })
  }
}
```

### Server Unavailable (500, network error)

Fall back to local tier from Supabase:

```typescript
async function checkPermissionSafely(
  userId: string,
  action: string,
  token: string
): Promise<boolean> {
  try {
    return await checkPermissionServer(userId, action, token)
  } catch (err) {
    // Fall back to local tier
    const localTier = getTierForUser(userId)
    return canActionUseLocalTier(action, localTier)
  }
}
```

### Rate Limiting (429)

Implement exponential backoff:

```typescript
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3
): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options)
      if (response.status !== 429) return response

      // Rate limited, back off
      const delay = Math.pow(2, attempt) * 1000
      await new Promise(resolve => setTimeout(resolve, delay))
    } catch (err) {
      if (attempt === maxRetries - 1) throw err
    }
  }
  throw new Error('Max retries exceeded')
}
```

## Testing

### Unit Tests

Test permission checking logic:

```typescript
describe('TierGuard', () => {
  it('denies terminal to Free tier', async () => {
    const allowed = await checkPermission('user-free', 'use_terminal')
    expect(allowed).toBe(false)
  })

  it('allows terminal to Enterprise tier', async () => {
    const allowed = await checkPermission('user-enterprise', 'use_terminal')
    expect(allowed).toBe(true)
  })
})
```

### Integration Tests

Test with real Tier Server running:

```bash
# Start server
python server/app.py

# Run integration tests
npm run test:integration
```

### Manual Testing

1. Create test users with different tiers
2. Try Pro/Enterprise actions (should fail for Free)
3. Upgrade user and verify they can now access
4. Check Stripe webhooks are syncing tiers correctly

## Deployment

### Development

```bash
# Terminal 1: Start tier server
cd server
python app.py

# Terminal 2: Start Electron app
npm start
```

### Production

Deploy tier server to production:

```bash
# Deploy to Heroku
git push heroku main

# Deploy to AWS Lambda
zappa deploy production

# Set environment variables in production
TIER_SERVER_URL=https://tier.openui.com  # In Electron .env
```

Configure webhook in Stripe Dashboard:

```
Endpoint: https://tier.openui.com/webhooks/stripe
Events: customer.subscription.created, customer.subscription.updated,
        customer.subscription.deleted, checkout.session.completed
```

## Monitoring & Debugging

### Check Tier Sync

```bash
# Test tier fetch
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:5000/user/user-123/tier
```

### Monitor Queue

```bash
# Check queue status
curl http://localhost:5000/queue/status | jq

# Check specific task
curl http://localhost:5000/queue/task/task-id
```

### Debug Redis

```bash
redis-cli
> KEYS "*"
> GET tier:user-123
> ZRANGE pending:queue 0 -1
```

### Server Logs

```bash
tail -f server.log
grep "Permission" server.log
grep "Stripe" server.log
```

## Troubleshooting

### "Tier server unavailable"

Check server is running and accessible:

```bash
curl http://localhost:5000/health
```

### "Permission denied" when should be allowed

1. Check user tier in Supabase:
   ```sql
   SELECT app_metadata->>'tier' FROM auth.users WHERE id = '...';
   ```

2. Check Stripe subscription is active
3. Clear Redis cache: `redis-cli DEL tier:user-id`
4. Force tier refresh from Supabase

### Queue tasks not executing

1. Check Redis is running: `redis-cli ping`
2. Check queue status: `curl http://localhost:5000/queue/status`
3. Check server logs for errors
