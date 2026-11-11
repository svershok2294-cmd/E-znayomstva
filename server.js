import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_ORIGINS = new Set(['https://e-znayomstva-test.onrender.com']);
const MAX_AGE_SECONDS = 300;
const ADMIN_TELEGRAM_ID = /^\d+$/.test(process.env.ADMIN_TELEGRAM_ID || '')
  ? process.env.ADMIN_TELEGRAM_ID
  : '';

// Repair only accidental literal line breaks inside the private_key JSON string.
// Keep all other JSON syntax strict; never print credentials in logs.
function parseServiceAccount(raw) {
  try {
    return JSON.parse(raw);
  } catch (originalError) {
    const start = /"private_key"\s*:\s*"/.exec(raw);
    if (!start) throw originalError;
    const from = start.index + start[0].length;
    let end = from;
    let escaped = false;
    while (end < raw.length) {
      const ch = raw[end];
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') break;
      end++;
    }
    if (end === raw.length) throw originalError;
    const value = raw.slice(from, end);
    if (!/[\r\n]/.test(value)) throw originalError;
    const repaired = value.replace(/\r\n|\r|\n/g, '\\n');
    return JSON.parse(raw.slice(0, from) + repaired + raw.slice(end));
  }
}

function loadTestFirebaseConfig(env) {
  const projectId = env.FIREBASE_TEST_PROJECT_ID;
  if (!projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) ||
      ['nazviazku', 'nazviazku-38b50'].includes(projectId)) {
    throw new Error('An isolated Firebase project is required');
  }

  const { apiKey, appId, authDomain, projectId: webProjectId } =
    JSON.parse(env.FIREBASE_TEST_WEB_CONFIG || '{}');
  if (projectId !== webProjectId || authDomain !== projectId + '.firebaseapp.com' ||
      typeof apiKey !== 'string' || !apiKey || typeof appId !== 'string' || !appId) {
    throw new Error('Invalid test Firebase web configuration');
  }

  // Return only the public fields needed by Firebase Auth and Firestore.
  return { apiKey, appId, authDomain, projectId };
}

let firebaseReady = false;
let firebaseWebConfig;
try {
  firebaseWebConfig = loadTestFirebaseConfig(process.env);
  const credentialJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || fs.readFileSync('/etc/secrets/firebase-service-account.json', 'utf8');
  const key = parseServiceAccount(credentialJson);
  if (key.project_id !== firebaseWebConfig.projectId) throw new Error('Unexpected Firebase project');
  initializeApp({ credential: cert(key), projectId: firebaseWebConfig.projectId });
  firebaseReady = true;
} catch {
  console.error('Firebase initialization unavailable: check isolated test project configuration');
}

function send(res, status, body, origin = '') {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (origin) { headers['Access-Control-Allow-Origin'] = origin; headers['Vary'] = 'Origin'; }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function verifyTelegram(initData, reportFailure = () => {}) {
  const reject = reason => { reportFailure(reason); return null; };
  if (!BOT_TOKEN || typeof initData !== 'string' || initData.length > 8192) return reject('invalid_input');
  const params = new URLSearchParams(initData);
  const hashes = params.getAll('hash');
  if (hashes.length !== 1 || !/^[a-f0-9]{64}$/i.test(hashes[0])) return reject('invalid_input');
  // Telegram WebApp HMAC covers every received field except hash, including signature when present.
  const pairs = [...params.entries()].filter(([key]) => key !== 'hash');
  const keys = pairs.map(([key]) => key);
  if (new Set(keys).size !== keys.length) return reject('invalid_input');
  const checkString = pairs.sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(checkString).digest();
  const supplied = Buffer.from(hashes[0], 'hex');
  if (!crypto.timingSafeEqual(expected, supplied)) return reject('invalid_signature');
  const authDate = Number(params.get('auth_date'));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(authDate)) return reject('missing_auth_date');
  if (authDate > now + 30 || now - authDate > MAX_AGE_SECONDS) return reject('expired_auth_date');
  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return reject('invalid_input');
    return { id: user.id, first_name: typeof user.first_name === 'string' ? user.first_name : '', username: typeof user.username === 'string' ? user.username : null };
  } catch { return reject('invalid_input'); }
}

// Opt-in test endpoint. Disabled unless ENABLE_TEST_SERVER_MOVES=true on the test backend.
async function createRateLimitedMove(body, idToken) {
  if (!firebaseReady) return { status: 503, body: { error: 'Firebase unavailable' } };
  const decoded = await getAuth().verifyIdToken(idToken, true);
  if (!/^telegram:[1-9][0-9]{0,15}$/.test(decoded.uid) || decoded.firebase?.sign_in_provider !== 'custom') return { status: 401, body: { error: 'Invalid account' } };
  const sender = decoded.uid.slice('telegram:'.length);
  const recipient = String(body.targetUserId || '');
  const message = body.myReply;
  if (!/^[1-9][0-9]{0,15}$/.test(recipient) || recipient === sender ||
      typeof message !== 'string' || !message.trim() || message.length > 1000) {
    return { status: 400, body: { error: 'Invalid recipient or message' } };
  }
  const firestore = getFirestore();
  const limitRef = firestore.collection('ez_message_limits').doc(sender + '_' + recipient);
  const users = firestore.collection('ez_users');
  const senderRef = users.doc(sender);
  const recipientRef = users.doc(recipient);
  const blockedBySender = firestore.collection('ez_blocks').doc(sender).collection('users').doc(recipient);
  const blockedByRecipient = firestore.collection('ez_blocks').doc(recipient).collection('users').doc(sender);
  const result = await firestore.runTransaction(async tx => {
    // All reads precede all writes. Firestore retries this transaction on contention.
    const [limit, senderProfile, user, block1, block2] = await Promise.all([
      tx.get(limitRef), tx.get(senderRef), tx.get(recipientRef), tx.get(blockedBySender), tx.get(blockedByRecipient)
    ]);
    if (senderProfile.data()?.isBanned) return { status: 403, body: { error: 'Messaging blocked' } };
    if (!user.exists || user.data().isBanned) return { status: 404, body: { error: 'Recipient unavailable' } };
    if (block1.exists || block2.exists) return { status: 403, body: { error: 'Messaging blocked' } };
    const previous = Number(limit.data()?.lastSentAt || 0);
    const remaining = 5000 - (Date.now() - previous);
    if (remaining > 0) return { status: 429, body: { error: 'Slow down', retryAfterSeconds: Math.ceil(remaining / 1000) } };
    const target = user.data();
    const newMove = firestore.collection('ez_moves').doc();
    tx.create(newMove, {
      fromUserId: sender,
      targetUserId: recipient,
      targetUsername: String(target.username || '').slice(0, 128),
      name: String(target.name || '').slice(0, 120),
      city: String(target.city || '').slice(0, 150),
      img: String(target.img || '').slice(0, 750000),
      myReply: message.trim(),
      createdAt: Date.now()
    });
    tx.set(limitRef, { lastSentAt: Date.now() }, { merge: true });
    return { status: 201, body: { ok: true, moveId: newMove.id } };
  });
  return result;
}

const server = http.createServer((req, res) => {
  // Test-only request trace: never log query strings, headers, tokens or user content.
  // Unknown paths are hashed rather than printed to avoid exposing identifiers.
  const pathOnly = String(req.url || '').split('?')[0];
  const safeRoute = ['/health', '/__diagnostic', '/firebase-config', '/auth/telegram', '/api/moves'].includes(pathOnly)
    ? pathOnly
    : 'other:' + crypto.createHash('sha256').update(pathOnly).digest('hex').slice(0, 10);
  console.log('HTTP route trace:', req.method, safeRoute);
  const origin = req.headers.origin || '';
  const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : '';
  // Test-only, read-only diagnostics. Never include credentials, tokens or user data.
  if (pathOnly === '/health' || pathOnly === '/__diagnostic') {
    console.log('Test route check:', req.method, pathOnly);
  }
  if (pathOnly === '/__diagnostic' && req.method === 'GET') {
    return send(res, 200, {
      service: 'e-znayomstva-test-auth',
      revision: String(process.env.RENDER_GIT_COMMIT || 'unknown').slice(0, 12),
      healthRoute: true,
      serverMovesEnabled: process.env.ENABLE_TEST_SERVER_MOVES === 'true',
      firebaseReady
    });
  }
  if (pathOnly === '/health' && req.method === 'GET') return send(res, 200, { ok: true, configured: Boolean(BOT_TOKEN), firebaseReady });
  if (pathOnly === '/firebase-config' && req.method === 'GET') {
    if (origin && !corsOrigin) return send(res, 403, { error: 'Origin not allowed' });
    if (!firebaseReady) return send(res, 503, { error: 'Test Firebase is unavailable' }, corsOrigin);
    return send(res, 200, firebaseWebConfig, corsOrigin);
  }
  if (pathOnly === '/api/moves' && process.env.ENABLE_TEST_SERVER_MOVES === 'true') {
    if (origin && !corsOrigin) return send(res, 403, { error: 'Origin not allowed' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Vary': 'Origin' });
      return res.end();
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }, corsOrigin);
    const authorization = String(req.headers.authorization || '');
    if (!/^Bearer [A-Za-z0-9._-]+$/.test(authorization)) return send(res, 401, { error: 'Missing token' }, corsOrigin);
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 8192) req.destroy(); });
    req.on('end', async () => {
      try {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: 'Invalid body' }, corsOrigin);
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Invalid body' }, corsOrigin);
        const result = await createRateLimitedMove(body, authorization.slice(7));
        return send(res, result.status, result.body, corsOrigin);
      } catch (error) {
        if (error.code?.startsWith?.('auth/')) {
          // Never expose tokens or Firebase internals to clients.
          console.warn('Move auth rejected:', error.code);
          return send(res, 401, { error: 'Invalid authentication', code: 'FIREBASE_SESSION_INVALID' }, corsOrigin);
        }
        console.error('Test move endpoint:', error.code || error.message);
        return send(res, 500, { error: 'Message unavailable' }, corsOrigin);
      }
    });
    return;
  }
  if (req.url !== '/auth/telegram') return send(res, 404, { error: 'Not found' });
  if (origin && !corsOrigin) return send(res, 403, { error: 'Origin not allowed' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' });
    return res.end();
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }, corsOrigin);
  if (!BOT_TOKEN || !firebaseReady) return send(res, 503, { error: 'Authentication not configured' }, corsOrigin);
  let data = '';
  req.on('data', chunk => {
    data += chunk;
    if (data.length > 16384) req.destroy();
  });
  req.on('end', async () => {
    try {
      const user = verifyTelegram(JSON.parse(data).initData, reason => console.warn('Telegram auth rejected:', reason));
      if (!user) return send(res, 401, { error: 'Invalid or expired Telegram authentication', code: 'TELEGRAM_AUTH_REJECTED' }, corsOrigin);
      const isAdmin = ADMIN_TELEGRAM_ID !== '' && String(user.id) === ADMIN_TELEGRAM_ID;
      const token = await getAuth().createCustomToken(
        'telegram:' + user.id,
        isAdmin ? { admin: true } : {}
      );
      return send(res, 200, { verified: true, token, user }, corsOrigin);
    } catch (error) { console.error('Authentication failed:', error.message); return send(res, 500, { error: 'Authentication unavailable' }, corsOrigin); }
  });
});
server.listen(PORT, '0.0.0.0', () => console.log('Telegram auth server listening on port ' + PORT));
// Diagnostic: identify the configured bot without exposing its token.
// The request is sent only to Telegram's official API; logs contain username only.
if (BOT_TOKEN) {
  fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/getMe', { signal: AbortSignal.timeout(8000) })
    .then(response => response.json())
    .then(result => console.log('Configured Telegram bot:', result.ok && result.result?.username ? '@' + result.result.username : 'TOKEN_REJECTED'))
    .catch(() => console.warn('Configured Telegram bot: LOOKUP_UNAVAILABLE'));
}


// Test-only notifications. The production Render service must not enable this flag.
// Telegram button opens the TEST bot chat; opening the Mini App remains a user action.
if (process.env.ENABLE_TEST_MOVE_NOTIFICATIONS === 'true' && firebaseReady && BOT_TOKEN) {
  const firestore = getFirestore();
  const receipts = firestore.collection('ez_test_notification_receipts');
  const seenInProcess = new Set();
  const lastSentTo = new Map();
  let initialized = false;

  async function notifyForMove(change) {
    if (change.type !== 'added' || seenInProcess.has(change.doc.id)) return;
    seenInProcess.add(change.doc.id);
    const move = change.doc.data() || {};
    const recipient = String(move.targetUserId || '');
    const sender = String(move.fromUserId || '');
    if (!/^[0-9]+$/.test(recipient) || !/^[0-9]+$/.test(sender) || recipient === sender) return;
    const now = Date.now();
    if (now - (lastSentTo.get(recipient) || 0) < 5000) return;
    lastSentTo.set(recipient, now);

    const receipt = receipts.doc(change.doc.id);
    try {
      // Atomic create prevents duplicate notifications after a server restart.
      // A failed Telegram send removes the receipt, allowing a future retry.
      await receipt.create({ recipient, createdAt: now, status: 'pending' });
    } catch (error) {
      if (error.code === 6 || error.code === 'already-exists') return;
      console.warn('Test notification receipt unavailable:', error.code || error.message);
      return;
    }
    try {
      const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: recipient,
          text: '💌 Нове повідомлення в «Е-Знайомства»!\n\n♞ Відкрийте тестовий застосунок, щоб прочитати та відповісти.',
          reply_markup: { inline_keyboard: [[{ text: '💬 Відкрити Е-Знайомства', web_app: { url: 'https://e-znayomstva-test.onrender.com/' } }]] }
        }),
        signal: AbortSignal.timeout(10000)
      });
      const result = await response.json();
      if (!result.ok) throw new Error('Telegram HTTP ' + (result.error_code || response.status));
      await receipt.update({ status: 'sent', sentAt: Date.now() });
    } catch (error) {
      console.warn('Test notification not delivered:', error.message);
      // Keep the pending receipt on ambiguous network failures to avoid duplicates.
      // Admin can inspect failed/pending receipts; no message body is stored.
    }
  }

  firestore.collection('ez_moves').orderBy('createdAt', 'desc').limit(100).onSnapshot(snapshot => {
    if (!initialized) {
      snapshot.docs.forEach(doc => seenInProcess.add(doc.id));
      initialized = true;
      console.log('Test notifications ready; historical messages ignored');
      return;
    }
    for (const change of snapshot.docChanges()) void notifyForMove(change);
    if (seenInProcess.size > 5000) seenInProcess.clear();
  }, error => console.warn('Test notifications listener:', error.message));
}

if (process.env.ENABLE_TEST_BOT_WELCOME === 'true' && BOT_TOKEN) {
  const api = 'https://api.telegram.org/bot' + BOT_TOKEN + '/';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function telegramCall(method, body, timeoutMs = 12000) {
    const response = await fetch(api + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
    });
    return response.json();
  }
  async function runWelcomePolling() {
    let offset;
    try {
      const info = await telegramCall('getWebhookInfo', {});
      if (!info.ok || info.result?.url) {
        console.warn('Test welcome polling disabled: webhook active or status unavailable');
        return;
      }
      const latest = await telegramCall('getUpdates', { offset: -1, limit: 1, timeout: 0 });
      if (!latest.ok) {
        console.warn('Test welcome polling unavailable:', latest.error_code || 'unknown');
        return;
      }
      offset = latest.result?.length ? latest.result[latest.result.length - 1].update_id + 1 : undefined;
      console.log('Test bot welcome polling started');
    } catch (error) {
      console.warn('Test welcome startup:', error.message);
      return;
    }
    while (true) {
      try {
        const result = await telegramCall('getUpdates', {
          ...(offset === undefined ? {} : { offset }), timeout: 20, limit: 20,
          allowed_updates: ['message']
        }, 28000);
        if (!result.ok) {
          console.warn('Test welcome polling error:', result.error_code || 'unknown');
          await sleep(12000);
          continue;
        }
        for (const update of result.result || []) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (msg?.chat?.type !== 'private' || !(msg.text || '').startsWith('/start')) continue;
          const firstName = typeof msg.from?.first_name === 'string'
            ? msg.from.first_name.replace(/[<>]/g, '').slice(0, 60) : 'друже';
          const greeting = '💛 Вітаємо в «Е-Знайомства», ' + firstName + '!\n\n'
            + '♟️ Знайомтеся, спілкуйтеся та знаходьте близьких за духом людей.\n\n'
            + 'Відкрийте застосунок через меню бота або кнопку під сповіщенням. ✨';
          // Remove the obsolete persistent reply keyboard installed by earlier /start.
          // The working Web App buttons attached to notifications remain unchanged.
          const reply = await telegramCall('sendMessage', {
            chat_id: msg.chat.id, text: greeting,
            reply_markup: { remove_keyboard: true }
          });
          if (!reply.ok) console.warn('Test welcome response failed:', reply.error_code || 'unknown');
        }
      } catch (error) {
        console.warn('Test welcome polling retry:', error.message);
        await sleep(5000);
      }
    }
  }
  void runWelcomePolling();
}
