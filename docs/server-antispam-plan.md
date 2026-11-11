# Server-side anti-spam design — TEST ONLY

Status: design proposal, NOT deployed. Do not apply Firestore rules globally without verifying all collections in the shared nazviazku project.

## Current issue
The 5-second client-side timer in index.html is bypassable. The existing ez_moves create rule has no rate-limit condition. Firebase security rules cannot query the most recent arbitrary ez_moves document.

## Proposed secure architecture
1. Add authenticated POST /api/moves to the **test** Render auth backend. Verify Firebase ID token using Firebase Admin SDK (UID must match telegram:<fromUserId>); never trust sender IDs from request body.
2. In a Firestore transaction, read a server-owned rate document ez_message_limits/{senderId}_{recipientId}, check the server timestamp and reject sends within 5 seconds (HTTP 429 with retryAfterSeconds). Write the message to ez_moves and update the rate document atomically. Validate recipient, block status in both directions, length and allowed fields. Use server time for createdAt.
3. Add abuse controls: per-sender global burst limit and sensible per-day quotas; do not expose rate-limit collection to clients.
4. In the test frontend, switch both chat replies and opening moves to POST /api/moves. Preserve current UI and show server-provided retry time. Keep UI cooldown as convenience, not security.
5. Once the test endpoint and both UI paths are verified on two accounts, change ez_moves create rule to deny client writes (allow create: if false), preserving existing participant read access. The Admin SDK bypasses Firestore Security Rules, so the backend must enforce the same checks itself.
6. Roll out in phases and test normal send, immediate repeat, after 5 seconds, blocked recipients, unauthenticated requests, and failed writes. Ensure no writes to production services or other app collections.

## Safety
Do not publish a blanket deny on ez_moves until the test backend and frontend are deployed and verified, or messaging will break.
No production main changes, no shared Firebase rule publication without explicit review.
