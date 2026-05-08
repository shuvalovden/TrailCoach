# TrailCoach (Sisu Coach)

Personal AI trail-running coach for Denis Shuvalov. Responds in Russian via Telegram, pulls training data from Strava, stores in Supabase, generates advice with Claude.

## Architecture

```mermaid
graph TD
    User["User (Telegram)"]
    TG["Telegram Bot API\n(webhook)"]
    Server["server.js\nExpress (CJS)"]
    Strava["Strava API\ndirect OAuth2\nGET /athlete/activities"]
    Supabase["Supabase\nPostgres · activities table\nstrava_config table"]
    Claude["Claude API\n@anthropic-ai/sdk\nclaude-sonnet-4-6"]
    Railway["Railway\nNode 20 · auto-deploy from GitHub"]
    GitHub["GitHub\nsource / CD trigger"]

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

    Strava -->|POST /webhook/strava/:secret\noptional native webhook| Server
    GitHub -->|push to main| Railway
    Railway -->|hosts| Server
```

## Data flow (on each Telegram message)

1. Telegram → `POST /webhook/telegram` (verified via `X-Telegram-Bot-Api-Secret-Token`)
2. Route command:
   - `/sync30d` → `syncStravaActivities()` — fetch last 30 days from Strava → upsert Supabase
   - `/feedback` → `getFeedbackResponse()` — Claude analysis of last 7 days
   - `/plan` → `getPlanResponse()` — Claude training plan for next week
   - anything else → `getCoachingResponse(text)` — reads Supabase, calls Claude
3. Query Supabase `activities` with flat JSON field extractions (PostgREST `->>`), format as text summary
4. Call Claude with `SYSTEM_PROMPT` (athlete profile + brevity rule + zones + plan) + summary
5. Send Claude reply back to Telegram via `fetch` (native Node, no telegram npm package)

## Telegram commands

| Command | Handler | Data window | max_tokens |
|---|---|---|---|
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
| `COMPOSIO_WEBHOOK_SECRET` | Secret path segment for Strava webhook URL |
| `STRAVA_CLIENT_SECRET` | Strava app client secret (OAuth2) |
| `PORT` | Server port (Railway sets this automatically) |

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhook/telegram` | Telegram message delivery |
| `POST` | `/webhook/strava/:secret` | Strava native webhook (optional) |
| `GET` | `/webhook/strava/:secret` | Strava subscription validation challenge |
| `GET` | `/health` | Health check |
| `GET` | `/setup/strava-oauth` | Start Strava OAuth2 flow (one-time) |
| `GET` | `/setup/strava-callback` | Strava OAuth2 callback; stores tokens |
| `GET` | `/setup/strava-webhook` | Register Strava push subscription (one-time) |

## Key notes

- **No Composio**: Strava access is direct OAuth2. Tokens stored in Supabase `strava_config` table (id=1). Auto-refresh if expiry within 5 min.
- **Strava account**: Denis Shuvalov, athlete id: 46894875, Strava app client_id: 233959.
- **Pull model**: Strava data is fetched on demand via `/sync30d` command. Native webhook at `/webhook/strava/:secret` is optional for real-time ingestion.
- **Supabase select**: `activities` query extracts flat fields from `raw` JSONB via PostgREST `->>`/`->` operators — no full `raw` object in memory.
- **Brevity**: `SYSTEM_PROMPT` instructs Claude to default to 3–5 sentences; expand only on explicit request.
- **Deployment**: Railway auto-deploys on push to `main` in GitHub. Node ≥ 20 required.
