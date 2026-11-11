# Production migration readiness — draft, not approved for deployment

Date: 2026-11-11. Scope: E-Знайомства only. **No changes to main, live Render services, or published Firebase Rules are authorized by this document.**

## Verified repository differences

- `main/index.html` (~85 KB) has no `signInWithCustomToken` and no `submitMoveViaServer`. It directly creates documents in `ez_moves`.
- Test `index.html` (~134 KB) uses verified Telegram → Firebase custom-token authentication and has `submitMoveViaServer` but still contains direct Firestore-write fallback paths.
- Test server `server.js` exposes `POST /api/moves` behind `ENABLE_TEST_SERVER_MOVES=true`, validates Firebase ID token and Telegram UID, checks blocklists, and enforces a per-recipient five-second transaction limit.
- The existing production Render auth service is pinned to the feature branch but runs an older deployed commit. Do not redeploy it implicitly: a fresh deploy could unexpectedly pick up all test code.

## Required migration sequence

1. **Back up** the live `main/index.html`, deployed production auth commit, published Firestore Rules, and production bot Web App URL. Keep a tested rollback path.
2. **Review test-only configuration**: test host, test auth URL, test bot, `serverMoves=0` fallback, `antispamCheck=1` diagnostic, `rateCheck` code (removed), and other test-specific behavior. Do not copy test-only endpoints into production.
3. **Prepare a separate production candidate branch**, with production URLs and a dedicated explicit `ENABLE_SERVER_MOVES` flag (do not rely on the test-only flag). Ensure the server permits only the expected origin and verifies every Firebase ID token. Preserve the existing UI design.
4. **Audit all message creation paths**: initial moves, chat replies, retries, notifications, and any older clients. Replace *every* direct `ez_moves.add` path with authenticated server submission before Firestore rule changes.
5. **Test candidate end-to-end** with two authorized Telegram test accounts: login, profile, photos, discovery, matches, chat, read receipts, push notifications, block/unblock, reports, five-second cooldown (HTTP 429), and offline/reopen behavior. Verify sender/recipient IDs and duplicate handling.
6. **Deploy production backend only after approval**, with separate production configuration, health checks, monitoring and rollback. Verify a real authenticated send through the production backend before changing the main site.
7. **Deploy approved production frontend** and verify all send paths use the backend. Account for existing open Telegram WebViews and cached/older clients: they will lose send capability after server-only Firestore Rules are published. Plan a controlled cutover and user-facing refresh handling.
8. **Only after confirming production migration and explicit approval**, update the *published* shared Firestore Rules by changing only `ez_moves` `allow create` to `false`, preserving all other applications' rules. Firebase Admin SDK on the trusted server will continue to write.
9. Verify post-cutover: legitimate sends work; direct client create is denied; blocked users cannot send; server returns 429 on early repeat; rollback procedure is ready.

## Current decision

**NOT READY to publish server-only Firestore Rules or redeploy production backend.** The main frontend still writes directly to Firestore. The test 429 report is encouraging, but backend logs/HTTP status have not been independently captured.

## Safety boundaries

- No secrets, Firebase service-account keys, bot tokens, or client private credentials in GitHub.
- Do not modify Na Zviazku, Mazvizku, or any unrelated Firestore collections.
- Do not change production bot menu, main branch, live hosting, or production Render environment without separate user approval.
