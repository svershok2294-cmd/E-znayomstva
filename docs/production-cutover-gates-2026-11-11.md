# Production cutover gate — 2026-11-11

**Status: HOLD. This checklist does not authorize any production deployment, Firebase Rules publication, or bot changes.**

## Confirmed in staging

- Test Telegram Mini App displayed `STAGING ✓` and `Вхід: підтверджено ✓`.
- Profile discovery and chat rendered for the agreed test accounts.
- Live authenticated diagnostic reported first `POST /api/moves` HTTP **201**, immediate second HTTP **429**, with `retryAfterSeconds: 5`. This verifies the test backend's live rate limiter for that account pair, not production readiness.
- Diagnostic panel removed from staging branch (commit `175265a`); Render staging deployed live. Test menu should use URL without `?serverCheck=1`.

## Production deployment hazards (confirmed)

- Render production auth service `e-znayomstva-auth` (`srv-dbp4of8n74is73crlfjg`) has **autoDeploy off** but its source branch is **`feature/telegram-secure-auth`**, not the production candidate. Triggering a deploy now risks deploying experimental code.
- Candidate backend requires `ENABLE_SERVER_MOVES=true` to expose `POST /api/moves`. Default is disabled. Production notifications are independently gated by `ENABLE_PRODUCTION_MOVE_NOTIFICATIONS=true`; leave disabled until verified.
- Existing production frontend on `main` directly writes to `ez_moves`. Publishing `allow create: if false` now would break existing clients.
- Firebase project `nazviazku` is shared with unrelated applications. Do not replace its published Rules wholesale.

## Required before approval

- [ ] Export/record current `main/index.html` SHA, deployed production backend commit and environment (without disclosing secrets), current production bot menu URL, and **exact currently published** Firestore Rules; prepare verified rollback.
- [ ] Confirm correct Render production branch or deploy an explicitly pinned candidate commit, with change approval. Never press Deploy while branch points to experimental feature.
- [ ] Review candidate backend security, error handling, token verification, CORS, message validation, transaction concurrency, and notification behavior. Run CI including mock tests.
- [ ] Verify production candidate against **separate** staging backend or safely controlled deployment; staging currently uses the test backend and shared Firestore.
- [ ] Ensure older Telegram WebViews and cached `main` clients are handled before server-only rules.
- [ ] Obtain explicit approval before deploying backend, updating `main`, enabling production env flags, changing production bot, or publishing Firebase Rules.
- [ ] Deploy backend first, test production endpoint, then frontend, then publish only reviewed minimal `ez_moves` rule change **after** all active clients migrate.
- [ ] Post-cutover verify legitimate send, blocked send, 429, direct client write denial, read receipts, notifications, and rollback.

## Recommended next safe action

Read-only inventory of production deployment commit, candidate CI status, and existing rules; do not modify live services.
