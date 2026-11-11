# Firebase for the Telegram test branch

This branch serves the Mini App at `https://e-znayomstva-test.onrender.com` and uses
`https://e-znayomstva-test-auth.onrender.com` for its configuration and authentication.

The test auth service needs these settings before a cloud test can run.

| Setting | Value |
| --- | --- |
| `FIREBASE_TEST_PROJECT_ID` | ID of a dedicated Firebase project for test data |
| `FIREBASE_TEST_WEB_CONFIG` | Firebase Web app configuration JSON for that project |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Service account JSON for that project, stored as a secret. The service also supports `/etc/secrets/firebase-service-account.json`. |
| `TELEGRAM_BOT_TOKEN` | Token of the dedicated test bot, stored as a secret |
| `ENABLE_TEST_SERVER_MOVES` | `true` for the test auth service |

The web configuration, project ID and service account must identify the same
project. Both `nazviazku` and `nazviazku-38b50` are blocked. The test client
requests public configuration before it sends Telegram sign-in data.

The isolated cloud project needs Firebase Auth, Firestore, the rules in
`firestore.rules` and both indexes from `firestore.indexes.json`. The GitHub
Actions workflow runs against local emulators using `npm run test:rules`.
