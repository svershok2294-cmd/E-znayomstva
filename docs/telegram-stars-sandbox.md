# Telegram Stars sandbox

Telegram's test server uses a separate user account and a separate bot created with its own BotFather. The existing test bot on the normal Telegram network cannot be used for sandbox Stars. See [Telegram test setup](https://core.telegram.org/bots/webapps#using-bots-in-the-test-environment).

## Prepare the test service

1. Create a separate Firebase project and register a Web App. Keep `nazviazku` and `nazviazku-38b50` outside this sandbox. Provision Firestore and enable Firebase Authentication in the new project.
2. Deploy only the sandbox rules using `firebase deploy --only firestore:rules --config firebase.sandbox.json --project <isolated-project-id>`. Verify the exact project ID before running the command. Use synthetic profiles.
3. Use a separate Render web service running `npm install --omit=dev` and `npm start`. The API and test Mini App share its HTTPS address. Set these variables on the sandbox service:

   | Key | Value |
   | --- | --- |
   | `TELEGRAM_BOT_TEST_MODE` | `true` |
   | `TELEGRAM_TEST_BOT_USERNAME` | Test-server bot username without `@` |
   | `APP_ORIGIN` | Exact HTTPS origin of the sandbox service, with no trailing slash |
   | `FIREBASE_TEST_PROJECT_ID` | Isolated Firebase project ID |
   | `FIREBASE_TEST_WEB_CONFIG` | Public Web App configuration JSON from that project |
   | `FIREBASE_SERVICE_ACCOUNT_JSON` | Service account JSON from the isolated project, stored privately |
   | `TELEGRAM_BOT_TOKEN` | Test-server token, stored privately |
   | `TELEGRAM_STARS_WEBHOOK_SECRET` | A separate random secret using 32–256 URL-safe characters |
   | `ENABLE_SERVER_MOVES` | `true` |
   | `ENABLE_TELEGRAM_STARS` | `true` |
   | `REGISTER_TEST_STARS_WEBHOOK` | `true` |

4. Confirm `/health` reports `telegramTestMode`, `firebaseReady`, `starsEnabled`, and `testWebhookReady` as true. Verify the test bot username in logs. The registration path calls only Telegram's test API and checks the username before setting the test webhook.
5. In the test-server BotFather, set the test bot's Mini App URL to the sandbox service root. Open it from the separate Telegram test account and register two synthetic profiles.

## Test payments

- Buy VIP with test Stars and verify the displayed expiration and the gold frame from the second account. Cancel a separate invoice and verify the prior expiration stays unchanged.
- Buy a gift for the second account. Verify that the gift appears once in its chat. Exercise blocked delivery and refunds.
- For a manual refund, use Telegram's test `refundStarPayment` method with the charge ID from the sandbox ledger. Confirm the webhook reconciles the displayed VIP period or removes the refunded gift from the chat.

Keep live payments disabled until the test passes and the purchase terms, payment support, and refund process are ready.
