Hi Team,

Thank you for sharing the assignment. I've gone through the requirements and spent some time thinking about the implementation approach. Before getting started, I'd like to share my understanding, clarify a few points that could influence the design, and outline how I'm planning to approach the solution.

1. Understanding of the Requirement

The goal is to build a Discord bot that automatically syncs team activity to JIRA, avoiding the need to maintain updates in both platforms manually.

My understanding of the mapping is:
- proj-* Discord channels map to JIRA projects.
- Discord threads map to JIRA Stories.
- Messages within threads become JIRA comments or trigger status updates.

The bot should also support historical backfill on startup, real-time event processing, and reliable syncing without creating duplicates during retries or restarts.

2. A Few Things I'd Like to Clarify

There are a few areas where I'd appreciate your input before finalizing the implementation:

User attribution: JIRA Cloud attributes API actions to the authenticated account. My plan is to use a single service account and include the Discord author's name in the comment. Where permissions allow, I'll also map the reporter to their JIRA account. Would this approach work, or is individual user attribution expected?

Thread model: Discord supports regular text-channel threads and forum-channel posts. I'm leaning towards forum channels since they align well with the milestone structure. Please let me know if you prefer regular threads.

Project mapping: I'll derive JIRA project keys from channel names, such as proj-checkout to CHECKOUT. For longer names, I'll normalize them to valid JIRA keys. If a corresponding project doesn't exist, I'll log and skip it rather than creating one. Is that acceptable?

Duplicate prevention: One scenario I'm particularly considering is a crash after creating a JIRA Story but before saving its mapping locally. To handle this, I'll maintain a Discord ID-to-JIRA ID mapping in PostgreSQL and also store the Discord thread ID on the JIRA issue as a label or property. This gives us another way to identify existing issues even if local state is lost. Would that be okay?

Status updates: I'll resolve JIRA transition IDs dynamically instead of hardcoding them, since workflows may differ between projects. If a transition isn't available, the comment will still be recorded and the skipped transition logged. For blocked, I'll use a label and comment rather than assuming a custom status exists.

Unmapped users: If a Discord user doesn't have a JIRA account mapping, I'd prefer to use the service account and mention the original author in the comment rather than skip their activity. Please let me know if you have a different preference.

Historical backfill: Should the bot sync the complete Discord history or only messages within a configurable time period? Also, should archived threads be included? I'd prefer a configurable cutoff to avoid too many JIRA API calls during initial startup.

Scale and hosting: Do you have an approximate idea of the expected daily event volume and number of project channels? Since the Discord Gateway requires a persistent connection, some free hosting platforms that sleep inactive services may not be reliable. I'll explore Fly.io or similar options. Would the VM mentioned in the assignment be available if required?

3. Initial Assumptions for v1

Unless you suggest otherwise, I'll proceed with the following:
- Single Discord guild initially, with multi-guild support considered for later.
- One service account for all JIRA operations.
- PostgreSQL for event persistence and Discord-to-JIRA mappings, with unique constraints.
- Discord thread IDs stored on JIRA issues for additional duplicate protection.
- Thread titles used as Story summaries and the first message as the description.
- Status commands parsed case-insensitively, with the last occurrence taking precedence.
- Every relevant message recorded as a comment.
- blocked handled through a label and comment.
- Bot and system-generated messages ignored.
- Configurable historical backfill.

4. Out of Scope for v1

To keep the initial implementation focused, I'll leave message edits, deletions, thread renames, attachment syncing, multi-guild support, and an admin dashboard out of scope. Skipped attachments will be mentioned in the corresponding comment rather than silently ignored. These limitations and possible future improvements will be documented in the README. A basic /health endpoint will be included.

5. Proposed Technical Approach

I'm planning to split the implementation into the following components:

Discord integration: Use discord.js for real-time events and startup backfill. Both will be normalized into a common event structure.

Queue and database: Use PostgreSQL as a durable event queue so pending events survive restarts. Events will be processed in order per project, with appropriate processing and failure states.

Sync engine: Keep the core logic separate and testable. It will determine whether an event requires Story creation, a comment, or a status transition, while checking existing mappings before making changes.

JIRA client: Build a small typed wrapper for issue lookup, creation, comments, and transitions. Handle rate limits, Retry-After, exponential backoff, and repeated failures through a dead-letter mechanism.

Deployment: Include Dockerfile, Docker Compose, and GitHub Actions for linting and tests on PRs, followed by Docker image builds and pushes on merges to main. The deployed service will expose a /health endpoint.

6. Implementation Plan

I'll start with the JIRA client and core synchronization logic, as these can be developed independently while the above questions are being clarified. I'll also commit changes incrementally and share brief daily updates covering progress, upcoming work, and any blockers.

These are my initial thoughts based on the assignment. I'm happy to adjust the approach based on your feedback.

Thanks,
Lakshan
