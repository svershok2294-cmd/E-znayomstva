# Read-only production deployment inventory — 2026-11-11

**No production changes made.** This document records independently queried GitHub/Render metadata; it is not a verified backup of Firestore or secrets.

| Component | Observed state |
|---|---|
| GitHub production frontend | `main/index.html` blob SHA `523f187ce4eeb39e6b541e91a5e9d2de982d3f65` (85,383 chars) |
| Existing production frontend message path | Contains `collection('ez_moves').add`; does not contain `submitMoveViaServer` |
| Production Render auth service | `e-znayomstva-auth`, `srv-dbp4of8n74is73crlfjg`, `https://e-znayomstva-auth.onrender.com` |
| Render configured source branch | `feature/telegram-secure-auth` (danger: not candidate or main) |
| Render automatic deployment | Disabled |
| Current live Render deploy | `dep-dbp71btbedkc73fsfeeg`, commit `2e797e036295443cdd13bac57afc0f51038c7c78`, status `live` |
| Previous Render deploy | `dep-dbp6ohu1egvs73b7tli0`, commit `c6aac0f728b95163e7efc24139c1b41b598662aa`, status `deactivated` |
| Staging static service | `srv-dbpq1poae00c73ca3ejg` |
| Current live staging deploy | `dep-dbpqorui0phs739d5ulg`, commit `175265a3570fc723930c87b8bc39a619b4ac3bc7`, status `live` |
| Live test evidence | Telegram Mini App screenshot: authenticated, HTTP 201 then HTTP 429, retry after 5 seconds |
| Shared Firebase | Project `nazviazku`; published rules not independently fetched or backed up |

## Critical distinction

The GitHub blob SHA above identifies the current **file**, not necessarily the full `main` commit. The Render deploy commit identifies the **backend version**, not an export of the deployed service configuration. This inventory is **not** a restorable backup.

## Blockers before production deployment

1. Export and securely retain the **currently published** Firebase Rules for the shared project; do not assume the draft file equals published rules.
2. Export a secure Firestore backup, including dating data, using an approved supported method. Do not put user data or credentials in GitHub.
3. Record production bot menu URL and relevant nonsecret Render environment configuration; verify a restore path.
4. Pin the backend to an explicitly reviewed candidate version before any deploy. Current Render branch points to experimental feature.
5. Plan for old Telegram WebViews that still write directly to `ez_moves`.
6. Obtain explicit approval for each live change (Render, main, Firebase Rules, bot menu).

**Do not trigger production deployment or publish server-only Firestore Rules yet.**
