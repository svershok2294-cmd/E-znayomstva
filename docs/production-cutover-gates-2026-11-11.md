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

## Read-only preflight and emulator evidence

- Production frontend rollback ref: `ae1be4aea19cd18678b8637660d0e8cbfc02a2b2` (`index.html` blob `523f187ce4eeb39e6b541e91a5e9d2de982d3f65`).
- Production API rollback reference: live deploy `dep-dbp71btbedkc73fsfeeg`, commit `2e797e036295443cdd13bac57afc0f51038c7c78`. Check artifact availability in Render before any production change.
- Test API verified separately: live deploy `dep-dbq452oae00c73d917i0`, commit `6d3a7d621d81c4c859c62df6f37a92fd4801ca75`.
- Published `nazviazku` Firestore Rules were exported on 2026-11-11. Backup SHA-256: `bd0103fcd3da78aa399262c9fa6e976b47b6249949c44a96a4fd828bea78619b`. Keep the private workspace copy for rollback and re-export immediately before any approved rollout. If the rules changed in the meantime, build the minimal patch against the new baseline.
- On `demo-e-znayomstva`, signed synthetic Telegram data went through the candidate HTTP login endpoint and Firebase Auth emulator. The admin received the claim, ordinary accounts did not. The candidate API accepted a message, rejected the immediate repeat and a blocked send, and returned 400 for malformed JSON. Firestore allowed the intended recipient to read the message and denied both outsider reads and direct client creates. The same flow passed with the minimal draft against the exported live rules, changing only client creation in `ez_moves`. The local harness used synthetic credentials, an explicit demo project override, and a stub for Telegram's bot lookup. This does not verify the production bot or browser cache behavior.

## Execution and rollback order

1. Pin the reviewed backend commit. Verify `nazviazku` and the production origin, enable only the server-send flag, and verify the backend before updating the frontend. Keep notification rollout separate.
2. Update the frontend and verify send and receive in a freshly opened Telegram Mini App. Existing open WebViews retain their loaded JavaScript, so test a session kept open across the frontend release and test relaunch. Keep direct creates available during this window. Use evidence of migration or an explicit decision about remaining old clients before the final rule change.
3. Review the latest live rules and disable only client creation in `ez_moves`. Verify the legitimate send, blocked send, rate limit, and denied direct create with test accounts after the approved change.
4. If reverting to the legacy frontend after step 3, first restore the prior rules or revert only the cutover rule if other rules changed. Revert the frontend while the API still serves already-open new clients. Roll back the backend only after accounting for those sessions, using the recorded commit and Render deploy as references.
