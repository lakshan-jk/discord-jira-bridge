# discord-jira-bridge

A bot that syncs Discord **forum** activity into **JIRA Cloud**. Each forum post
becomes a Story; the conversation on it becomes JIRA comments and status
transitions. Ingestion is decoupled from JIRA writes by a durable Postgres queue,
so the bridge survives restarts and JIRA outages without losing or duplicating
work.

> **Deployment pending.** The public endpoints below are placeholders until the
> app is deployed. Replace them once it's live.
>
> - **Health check:** `https://<YOUR-APP>.fly.dev/health` → `{"status":"ok","db":"up"}`
> - **Discord invite:** `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&...` _(invite the bot to your server)_

---

## What it does: the Discord → JIRA mapping

The model (confirmed with the team — see [`design-decisions.md`](./design-decisions.md)):

| Discord                        | JIRA                          | Notes |
| ------------------------------ | ----------------------------- | ----- |
| Forum **channel**              | **Project**                   | Project key derived from the channel name: `proj-checkout` → `CHECKOUT`, `proj-payment-service` → `PAYMENTSERVICE`. If no matching project exists, the event is logged and skipped — never auto-created. |
| Forum **post / thread**        | **Story** (issue)             | The thread title becomes the summary; the starter message becomes the description. |
| **Message** in a thread        | **Comment** on the Story      | Prefixed with the Discord author's display name. |
| `/status <name>` message       | **Status transition**         | Resolved against the issue's real workflow at runtime (never hardcoded). |
| `/blocked` message             | **`blocked` label + comment** | Handled as a label rather than assuming a custom workflow status exists. |

**Attribution:** a single JIRA service account performs every API call. The
Discord author's name is carried in the comment body, so no activity is
anonymous and nothing is silently dropped for unmapped users.

**Idempotency:** every Story is deduplicated two ways — a unique
`Discord-thread-ID → JIRA-issue` mapping in Postgres (primary), plus a thread-ID
marker stamped onto the JIRA issue itself (backup that survives local state
loss). A crash between "issue created" and "mapping saved" cannot produce a
duplicate.

## The four actions

1. **Create** — a new forum post creates a Story. Order of checks:
   project exists? → DB mapping? → JIRA thread-ID marker? → only then create and
   save the mapping. Re-delivery of the same event is a no-op (`deduped`).

2. **Comment** — a message in a thread is added as a comment on the mapped
   Story. If the Story can't be found, the event is skipped (not failed).

3. **Transition** — `/status In Progress` moves the Story. The comment is
   **always recorded first**, then the transition is attempted. Transition IDs
   are resolved dynamically per project; if the target isn't offered by that
   workflow, the comment still lands and the skip is logged. `/blocked` applies
   the `blocked` label instead of a transition.

4. **Resync** — `!resync` typed in a forum channel sweeps every thread in that
   channel through the same idempotent create path, backfilling only the missing
   Stories, then replies in-channel with a summary
   (`checked N, created X, already synced Y`). On startup the bridge also runs a
   **bounded** backfill controlled by `BACKFILL_LOOKBACK_HOURS` so a first boot
   doesn't flood JIRA with historical writes.

---

## Setup & run locally (docker-compose)

**Prerequisites:** Docker + Docker Compose. Real syncing additionally needs a
Discord bot token and a JIRA Cloud service account; without them the bot still
boots, serves `/health`, and runs the worker — only Discord ingestion is
disabled (an invalid token just logs a warning).

```bash
# 1. Configure. The example placeholders are valid in *format*, so the stack
#    boots and /health works even before you have real credentials.
cp .env.example .env
#    Edit .env and fill in real values to enable syncing:
#      JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, DISCORD_BOT_TOKEN

# 2. Bring up the bot + Postgres together (builds the image on first run).
docker compose up --build          # add -d to detach

# 3. Verify.
curl http://localhost:3000/health  # -> {"status":"ok","db":"up"}

# Stop (keeps the DB volume); add -v to also wipe the data.
docker compose down
```

Compose reads the JIRA/Discord secrets from your shell env or `.env` and injects
them; Postgres is reached by its compose service name, and the schema is migrated
idempotently on startup. See [`docker-compose.yml`](./docker-compose.yml).

### Running without Docker

```bash
npm install
docker compose up -d postgres   # or point DATABASE_URL at any Postgres
npm run dev                     # tsx, reads .env; or `npm start` for the built JS
```

### Configuration

Every environment variable is declared and validated by zod on startup
([`src/config/schema.ts`](./src/config/schema.ts)) — the process refuses to boot
if anything is missing or malformed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `JIRA_BASE_URL` | — | JIRA Cloud site URL |
| `JIRA_EMAIL` | — | Service-account email |
| `JIRA_API_TOKEN` | — | Atlassian API token |
| `DISCORD_BOT_TOKEN` | — | Discord bot token |
| `DATABASE_URL` | — | Postgres connection string |
| `PORT` | `3000` | `/health` port |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `BACKFILL_LOOKBACK_HOURS` | `24` | Startup backfill window |
| `BACKFILL_INCLUDE_ARCHIVED` | `false` | Include archived threads in backfill |

---

## Running the tests

```bash
npm test                  # unit tests (vitest) — pure logic, in-memory stores, no Docker needed
npm run test:integration  # integration tests — require a running Postgres (docker compose up -d postgres)
npm run lint              # eslint
npm run typecheck         # tsc --noEmit
```

The retry policy, mapper, normalizer, sync engine, worker, and ADF conversion are
all covered by fast unit tests against fakes; `tests/integration/` exercises the
real Postgres queue (claim/retry/dead-letter).

---

## Architecture (high level)

```
Discord Gateway ─▶ Ingestor ─▶ [ Postgres queue ] ─▶ Worker ─▶ Sync Engine ─▶ JIRA Cloud
   (events)      normalize &      durable, at-        drains      one event,     (service
                   enqueue        least-once        one at a time  one effect     account)
                                      │                               │
                                 mapping store (dedup) ◀──────────────┘
    HTTP /health ◀─ liveness + DB connectivity probe
```

- **Ingestor** ([`src/discord`](./src/discord)) — the only part that touches
  discord.js. It normalizes raw gateway/backfill payloads into one internal event
  shape and enqueues them. It never calls JIRA, which is what lets the queue
  guarantee at-least-once delivery across restarts.
- **Queue** ([`src/db/queue.ts`](./src/db/queue.ts)) — Postgres-backed, claims
  with `FOR UPDATE SKIP LOCKED` for safe concurrency and per-project ordering.
  Owns the retry/backoff/dead-letter decision ([`retry-policy.ts`](./src/db/retry-policy.ts)):
  permanent errors (4xx≠429) dead-letter immediately; transient errors (429, 5xx,
  network) retry with exponential backoff honouring JIRA's `Retry-After`, then
  dead-letter at max attempts so a poison event can't block its project forever.
- **Worker** ([`src/worker`](./src/worker)) — drains the queue, hands each event
  to the engine, and settles it (done/failed). Pure control loop, no business
  logic.
- **Sync Engine** ([`src/sync`](./src/sync)) — one event in, one JIRA effect out.
  Owns dedup, create ordering, and the comment-before-transition guarantee.
- **JIRA client** ([`src/jira`](./src/jira)) — thin REST wrapper with ADF body
  conversion and error classification.
- **Composition root** ([`src/index.ts`](./src/index.ts)) — wires everything,
  brings `/health` and the worker up unconditionally, and degrades gracefully if
  Discord credentials aren't present.

Design is dependency-injected throughout: every unit is testable against fakes
and the in-memory stores, so the behaviour verified in tests is the behaviour
that runs in production.

---

## Deploying (Fly.io)

Deployment is pending, but the config is in place. [`fly.toml`](./fly.toml)
builds the repo's `Dockerfile`, serves on internal port 3000, and uses `/health`
as the HTTP check. No secrets live in that file.

```bash
fly launch --no-deploy                         # create the app from fly.toml
fly postgres create --name <app>-db            # provision Postgres...
fly postgres attach <app>-db                   # ...sets DATABASE_URL as a secret
fly secrets set \                              # JIRA + Discord secrets
  JIRA_BASE_URL=https://your-site.atlassian.net \
  JIRA_EMAIL=service-account@your-org.com \
  JIRA_API_TOKEN=... DISCORD_BOT_TOKEN=...
fly deploy
curl https://<app>.fly.dev/health              # -> {"status":"ok","db":"up"}
```

Setting a secret triggers a rolling restart, so the app picks up new values
automatically. Follow logs with `fly logs`.

---

## From prototype to production

This is scoped as an assignment, and the team agreed to keep volume minimal. The
following is an honest account of what I would **not** trust as-is and what I'd
change before running it for a real team.

### What I wouldn't trust in prod yet

- **Single-instance, at-least-once, no end-to-end idempotency on comments.**
  Story creation is genuinely idempotent (DB mapping + JIRA marker). **Comments
  and transitions are not** — the queue is at-least-once, so a crash after
  posting a comment but before `markDone` will re-post that comment on retry.
  Before prod I'd stamp each comment with its Discord message ID (as a property
  or a body marker) and check-before-post, same pattern as Stories.
- **`!resync` and startup backfill are unbounded in width.** They list *all*
  threads and filter in memory. On a large forum that's a lot of Discord API
  calls and a burst of JIRA writes. Fine at assignment scale; needs pagination,
  chunking, and a concurrency cap before trusting it on a big server.
- **The service-account attribution model** is a deliberate simplification.
  Every action shows up as one bot user in JIRA. Acceptable and approved here,
  but a real deployment may want OAuth per-user attribution or at least an
  audit trail.
- **No alerting on the dead-letter queue.** Events that exhaust retries land in
  dead-letter and are currently invisible unless you read logs/DB. That's a
  silent-data-loss risk in disguise.

### What breaks under load

- **One worker, one event at a time.** Throughput is bounded by JIRA latency ×
  serial processing. The queue already uses `SKIP LOCKED` and per-project
  ordering, so the fix is horizontal: run N workers; ordering stays correct
  per project because rows are locked per project.
- **JIRA rate limits.** We honour `Retry-After` on 429s with backoff, but there's
  no proactive client-side rate limiter or token bucket, so a large backfill can
  spend a while bouncing off 429s instead of pacing itself.
- **Backfill memory.** Listing all threads/messages into memory doesn't scale;
  it needs streaming/pagination.
- **Discord gateway reconnection.** discord.js handles reconnects, but a long
  disconnect means missed real-time events; the safety net is `!resync` /
  restart backfill rather than gateway replay.

### How I'd handle the production concerns

- **Secrets.** Already out of source and the image: injected via env, `.env` is
  gitignored, Fly uses `fly secrets` (encrypted, rolling-restart on change). In a
  larger setup I'd move to a secrets manager (Vault / AWS Secrets Manager / Fly
  secrets) with rotation, and give JIRA/Discord tokens least-privilege scopes.
- **Rate limits.** Keep the `Retry-After`-aware backoff, but add a client-side
  limiter (token bucket per JIRA site) and concurrency caps on backfill/resync so
  we pace *before* hitting 429s rather than reacting to them.
- **Monitoring.** Structured logs already exist. I'd add: `/metrics` (queue depth,
  dead-letter count, processing latency, JIRA error rates), alerts on
  dead-letter growth and on `/health` failing, and request tracing from Discord
  event → JIRA effect.
- **Recovery.** The durable queue already gives crash-safety (in-flight events
  are reclaimed via `reclaimStale`, nothing is lost on restart). I'd add: a
  dead-letter **replay** tool once the root cause is fixed, per-comment
  idempotency (above) so replay is safe, and periodic reconciliation (`!resync`
  on a schedule) to catch anything the gateway missed.
- **Cost.** Footprint is tiny (one small container + small Postgres). The real
  cost levers are JIRA/Discord API usage, not compute: bound backfill windows
  (already configurable), dedup aggressively to avoid redundant writes, and
  scale workers to demand (idle loop is cheap). At this volume it fits
  comfortably in a free/hobby tier; I'd add a budget alert before enabling wide
  backfills.
```
