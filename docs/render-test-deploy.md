# Test deploy for Е — Знайомства

The test frontend uses `https://e-znayomstva-candidate-stage.onrender.com` and the existing test API `https://e-znayomstva-test-auth.onrender.com`. Both services have automatic deploys disabled. Use the test API service `srv-dbp775h42hec73bpnv50` in Render for any manual API deploy.

## Build and verify

1. Run `npm ci` and `npm run test:rules` with Java 21. The test command starts a loopback Firestore emulator under `demo-e-znayomstva`. It loads the branch rules and seeds synthetic data.
2. For a test API deploy, use the reviewed test backend commit `6d3a7d6` from `fix/test-telegram-auth-session`. It includes the numeric admin ID fix. Select the commit explicitly because the service's configured branch is `feature/telegram-secure-auth`. The backend in the rules branch is inherited from the staging frontend base and is unsuitable for replacing the current test API.
3. Check the API build command `npm install`, start command `npm start`, and exact staging CORS origin `https://e-znayomstva-candidate-stage.onrender.com`. The API checks the credential's project ID against `nazviazku` at startup. Keep the test bot credential in Render. Confirm that automated notifications and polling are disabled for a deployment that only checks health and authentication.
4. After a test deploy, verify the commit and the `live` status in Render. Check application and build logs, then expect `200` from `GET /health` with `configured: true` and `firebaseReady: true`. Expect `204` for an allowed-origin preflight, `401` for invalid Telegram data and `401` from `POST /api/moves` without authorization. A positive login and admin-claim check requires launching through the test bot with valid Telegram init data.
5. Use the emulator for message writes and rule enforcement. The Render test API uses the shared Firestore project. A successful message request against that API would write to shared data, and a Render deploy does not activate the branch rules.

## Rules review

The staging feed reads full `ez_users` documents for authenticated Telegram accounts. Review existing profile fields before any rules rollout because Firestore cannot hide individual fields in a document. The rules bind the profile document and `tgId` to the caller's UID. The stored username is syntax-validated and the current authentication flow does not provide a signed username claim for Rules to compare. Direct client message creation is disabled in the branch rules, so any live rollout requires migrating the older frontend message path first.
