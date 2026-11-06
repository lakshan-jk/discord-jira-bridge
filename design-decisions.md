# Design Decisions

This document records the key design choices, the alternatives considered, and
the tradeoffs accepted. It is kept updated as the project evolves.

## Confirmed with the team (email, 6 Nov 2026 — Kunal Sangwan)

All of the following were proposed in the kickoff plan email and explicitly
approved by the team.

### 1. User attribution
- **Decision:** A single JIRA service account performs all API operations. The
  Discord author's name is included in the comment body. Where a mapped JIRA
  account exists and permissions allow, the reporter is set to that account.
- **Why:** JIRA Cloud attributes every API action to the authenticating user;
  genuine per-user attribution would require each user's own credentials, which
  is out of scope for this exercise.
- **Tradeoff:** Comments appear under one service account rather than each
  individual, in exchange for a far simpler and more secure auth model.
- **Status:** Approved ("Yes, this works").

### 2. Thread model
- **Decision:** Use Discord **forum channels**, where each forum post is a thread
  (a milestone).
- **Why:** The forum model maps cleanly to "channel = project, post = milestone".
- **Status:** Approved ("Forum channels will do").

### 3. Project mapping
- **Decision:** Derive the JIRA project key from the channel name
  (`proj-checkout` -> `CHECKOUT`), normalising longer names to a valid key.
  If no matching JIRA project exists, log and skip — never auto-create.
- **Status:** Approved ("Yes").

### 4. Duplicate prevention (idempotency)
- **Decision:** Maintain a Discord-ID -> JIRA-ID mapping in PostgreSQL (unique
  constraint), and additionally stamp the Discord thread ID onto the JIRA issue
  (label or property). Before creating, check both so a crash between "issue
  created" and "mapping saved" cannot produce a duplicate.
- **Why:** The DB mapping is the primary, strongly-consistent dedup; the issue
  marker is a backup that survives local state loss.
- **Tradeoff:** An extra lookup/write per create, in exchange for correctness
  under partial failure.
- **Status:** Approved ("Yes, this is ok").

### 5. Status transitions
- **Decision:** Resolve transition IDs dynamically per project (never hardcoded).
  If a requested transition is unavailable, still record the comment and log the
  skipped transition. Handle `blocked` via a label + comment rather than assuming
  a custom workflow status exists.
- **Status:** Approved ("Works").

### 6. Unmapped users
- **Decision:** When a Discord author has no JIRA mapping, use the service
  account and mention the original author in the comment, rather than skipping.
- **Why:** No activity is silently lost.
- **Status:** Approved ("We can use service account, mention the author").

### 7. Historical backfill
- **Decision:** Backfill is bounded by a **configurable time cutoff** on startup,
  to avoid a flood of JIRA writes.
- **Status:** Approved ("We can keep the time period configurable").

### 8. Scale and hosting
- **Decision:** Keep the deployment minimal — this is an assignment, not a
  production load. Still deliver Docker, CI/CD, and a deployed `/health`
  endpoint as required, but do not over-engineer for high throughput.
- **Note:** The team confirmed volume can be kept minimal. Scaling paths are
  documented in the README's "path to production" rather than built now.
- **Status:** Approved ("Yes, you can keep it to minimal. This is for assignment only").
