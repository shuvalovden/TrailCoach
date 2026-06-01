# TrailCoach (Sisu Coach)

Personal AI trail-running coach for Denis Shuvalov. Responds in English via Telegram, pulls training data from Strava, stores in Supabase, generates advice with Claude.

## Architecture

```mermaid
graph TD
    User["User (Telegram)"]
    TG["Telegram Bot API\n(webhook)"]
    Server["server.js\nExpress (CJS)"]
    Strava["Strava API\ndirect OAuth2\nGET /athlete/activities"]
    Supabase["Supabase\nPostgres · activities table\nstrava_tokens table"]
    Claude["Claude API\n@anthropic-ai/sdk\nclaude-sonnet-4-6"]
    Azure["Azure Container Apps\nDocker · Node 20-alpine\nItaly North"]
    GitHub["GitHub\nsource"]

    User -->|message / command| TG
    TG -->|POST /webhook/telegram| Server
    Server -->|/sync30d: syncStravaActivities| Strava
    Strava -->|activities JSON| Server
    Server -->|upsert| Supabase
    Server -->|SELECT last 30d or 7d| Supabase
    Supabase -->|formatted summary| Server
    Server -->|system prompt + summary + user text| Claude
    Claude -->|coaching reply| Server
    Server -->|sendMessage| TG
    TG -->|reply| User

    Strava -->|POST /webhook/strava/:secret\nnative webhook| Server
    GitHub -->|manual: deploy-azure.ps1| Azure
    Azure -->|hosts| Server
```

## Data flow (on each Telegram message)

1. Telegram → `POST /webhook/telegram` (verified via `X-Telegram-Bot-Api-Secret-Token`)
2. Route command:
   - `/start` → static welcome message with command list
   - `/connect` → Strava OAuth2 link with `state=chatId`
   - `/sync30d` → `syncStravaActivities()` — fetch last 30 days from Strava → upsert Supabase
   - `/feedback` → `getFeedbackResponse()` — Claude analysis of last 7 days
   - `/plan` → `getPlanResponse()` — Claude training plan for current or next week
   - anything else → `getCoachingResponse(text)` — reads Supabase, calls Claude
3. Query Supabase `activities` filtered by `user_id`, format as text summary
4. Call Claude with system prompt = static `FORMATTING_RULES` (in code) + `users.profile_text` fetched from Supabase (athlete profile, zones, plan) + summary
5. Send Claude reply back to Telegram via `fetch` (native Node, no telegram npm package)

## Telegram commands

| Command | Handler | Data window | max_tokens |
|---|---|---|---|
| `/start` | static reply | — | — |
| `/connect` | inline handler | — | — |
| `/sync30d` | `syncStravaActivities()` | — | — |
| `/feedback` | `getFeedbackResponse()` | 7 days | 800 |
| `/plan` | `getPlanResponse()` | 30 days | 1000 |
| _(free text)_ | `getCoachingResponse()` | 30 days | 500 |

## Dependencies

| Package | Role |
|---|---|
| `express` | HTTP server, webhook routing |
| `dotenv` | Load `.env` vars at startup |
| `@anthropic-ai/sdk` | Claude API client |
| `@supabase/supabase-js` | Supabase DB client |
| Node built-in `fetch` | Strava API + Telegram Bot API calls |

## Environment variables

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_WEBHOOK_SECRET` | Secret for `X-Telegram-Bot-Api-Secret-Token` header |
| `COMPOSIO_WEBHOOK_SECRET` | Secret path segment for Strava webhook URL and setup endpoints |
| `STRAVA_CLIENT_SECRET` | Strava app client secret (OAuth2) |
| `APP_BASE_URL` | Public base URL of the deployed app (used for OAuth redirect URIs and webhook registration) |
| `PORT` | Server port (Azure sets this automatically) |

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhook/telegram` | Telegram message delivery |
| `POST` | `/webhook/strava/:secret` | Strava native webhook |
| `GET` | `/webhook/strava/:secret` | Strava subscription validation challenge |
| `GET` | `/health` | Health check |
| `GET` | `/setup/strava-oauth` | Start Strava OAuth2 flow (one-time) |
| `GET` | `/setup/strava-callback` | Strava OAuth2 callback; stores tokens per user |
| `GET` | `/setup/strava-webhook` | Register Strava push subscription (one-time) |

## Key notes

- **No Composio**: Strava access is direct OAuth2. Tokens stored in `strava_tokens` per user (primary store). `strava_config` (id=1) is legacy — only used as fallback in `fetchStravaActivity` when `userId` is null. Auto-refresh if token expiry within 5 min.
- **Strava account**: Denis Shuvalov, athlete id: 46894875, Strava app client_id: 233959, telegram_chat_id: 546691918.
- **Pull model**: Strava data is fetched on demand via `/sync30d`. Native webhook at `/webhook/strava/:secret` handles real-time ingestion; routes to the correct user by `owner_id`.
- **Supabase select**: `activities` query reads full `raw` JSONB column; `formatActivities()` accesses fields via `a.raw?.field`.
- **System prompt**: static `FORMATTING_RULES` (in `server.js`) + per-user `users.profile_text` from Supabase. Combined by `getSystemPrompt(chatId)`, cached per `chatId` in a `Map` (no cross-user cache pollution).
- **Multi-user**: `findOrCreateUser(chatId)` resolves user on every Telegram message. `is_active` flag gates access. All activity queries filtered by `user_id`. Strava functions take `userId` (uuid from `users` table).
- **Rate limiter**: in-memory `Map` per `userId`, 20 AI requests/user/day (resets at midnight UTC). Applied in `getCoachingResponse`, `getFeedbackResponse`, `getPlanResponse`. Not applied to `/sync30d` or `/connect`.
- **Security**: `users.is_active` flag manually set in Supabase to block a user. Checked on every Telegram message before any processing.
- **Deployment**: Docker image built and pushed to Azure Container Registry (`trailcoachreg`), deployed to Azure Container Apps (`trailcoach-app`, resource group `trailcoach-rg`, Italy North). Run `.\deploy-azure.ps1` to deploy. No CI/CD — manual trigger only.
- **APP_BASE_URL**: used for Strava OAuth redirect URI and webhook callback URL. Set via env var — no hardcoded URLs in code.
- **Monitoring (in-memory)**: module-level `metrics` object tracks counters (telegram messages, Claude calls/tokens/errors, Strava syncs/webhooks/token refreshes, Supabase errors, rate limit hits) and Claude latency (last 10 calls for p50/p90). Exposed via `GET /health`. Resets on restart.
- **Monitoring (persistent)**: `flushMetrics()` upserts daily aggregates to `metrics_daily` table every 3 hours via `setInterval`, and on `SIGTERM` before shutdown. Overwrites the row for today with current in-memory totals — no SQL increments.

## Database schema

```sql
-- Multi-user identity
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id  bigint UNIQUE NOT NULL,
  strava_athlete_id bigint UNIQUE,
  name              text,
  profile_text      text,   -- athlete profile, zones, plan, principles (user-specific part of system prompt)
  is_active         boolean DEFAULT true,
  created_at        timestamptz DEFAULT now()
);

-- Strava OAuth2 tokens per user
CREATE TABLE strava_tokens (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token  text NOT NULL,
  refresh_token text NOT NULL,
  expires_at    bigint NOT NULL
);

-- Training activities (one per Strava activity)
CREATE TABLE activities (
  id            bigserial PRIMARY KEY,
  strava_id     bigint UNIQUE NOT NULL,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  type          text,
  distance_m    float8,
  moving_time_s int,
  started_at    timestamptz,
  raw           jsonb    -- full Strava activity object
);
-- Indexes: activities(user_id, started_at DESC)

-- Legacy single-user token store (fallback only in fetchStravaActivity)
CREATE TABLE strava_config (
  id            int PRIMARY KEY,
  access_token  text,
  refresh_token text,
  expires_at    bigint
);

-- Daily metrics (persistent; flushed every 3h and on SIGTERM)
CREATE TABLE IF NOT EXISTS metrics_daily (
  date               date PRIMARY KEY,
  telegram_messages  int DEFAULT 0,
  claude_calls       int DEFAULT 0,
  claude_errors      int DEFAULT 0,
  tokens_input       bigint DEFAULT 0,
  tokens_output      bigint DEFAULT 0,
  strava_syncs       int DEFAULT 0,
  strava_sync_errors int DEFAULT 0,
  strava_webhooks    int DEFAULT 0,
  supabase_errors    int DEFAULT 0,
  ratelimit_hits     int DEFAULT 0,
  updated_at         timestamptz DEFAULT now()
);
```
