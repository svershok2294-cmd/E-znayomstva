import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Browser Origin for GitHub Pages contains only scheme + host (no repo path).
const ALLOWED_ORIGINS = new Set([
  'https://svershok2294-cmd.github.io',
  'https://e-znayomstva-test.onrender.com',
  ...(process.env.APP_ORIGIN ? [process.env.APP_ORIGIN] : [])
]);
const MAX_AGE_SECONDS = 300;
const ADMIN_TELEGRAM_ID = /^\\d+$/.test(process.env.ADMIN_TELEGRAM_ID || '')
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

let firebaseReady = false;
try {
  const credentialJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || fs.readFileSync('/etc/secrets/firebase-service-account.json', 'utf8');
  const key = parseServiceAccount(credentialJson);
  if (key.project_id !== 'nazviazku') throw new Error('Unexpected Firebase project');
  initializeApp({ credential: cert(key) });
  firebaseReady = true;
} catch (error) {
  console.error('Firebase initialization unavailable:', error.message);
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

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : '';
  if (req.url === '/health' && req.method === 'GET') return send(res, 200, { ok: true, configured: Boolean(BOT_TOKEN), firebaseReady });
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
      if (!user) return send(res, 401, { error: 'Invalid or expired Telegram authentication' }, corsOrigin);
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


// Test-only Telegram notifications. This process must be deployed ONLY to the
// e-znayomstva-test-auth service: production uses a separate, pinned deployment.
// The first snapshot is a baseline; historical messages are never re-sent.
if (process.env.ENABLE_TEST_MOVE_NOTIFICATIONS === 'true' && firebaseReady && BOT_TOKEN) {
  let initialized = false;
  const delivered = new Set();
  const lastSentTo = new Map();
  const firestore = getFirestore();
  const movesQuery = firestore.collection('ez_moves').orderBy('createdAt', 'desc').limit(100);
  movesQuery.onSnapshot(snapshot => {
    if (!initialized) {
      snapshot.docs.forEach(doc => delivered.add(doc.id));
      initialized = true;
      console.log('Test move notifications: watching new messages');
      return;
    }
    for (const change of snapshot.docChanges()) {
      if (change.type !== 'added' || delivered.has(change.doc.id)) continue;
      delivered.add(change.doc.id);
      const move = change.doc.data() || {};
      const recipient = String(move.targetUserId || '');
      const sender = String(move.fromUserId || '');
      if (!/^[0-9]+$/.test(recipient) || !/^[0-9]+$/.test(sender) || recipient === sender) continue;
      const now = Date.now();
      if (now - (lastSentTo.get(recipient) || 0) < 5000) continue;
      lastSentTo.set(recipient, now);
      // Never send message bodies or private profile details via bot notification.
      const text = '💌 Нове повідомлення в «Е-Знайомства»!\n\n♞ Відкрийте тестовий застосунок, щоб прочитати та відповісти.';
      fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: recipient, text }),
        signal: AbortSignal.timeout(10000)
      }).then(res => res.json()).then(result => {
        if (!result.ok) console.warn('Test notification not delivered:', result.error_code || 'telegram_error');
      }).catch(err => console.warn('Test notification request failed:', err.message));
    }
    if (delivered.size > 5000) delivered.clear();
  }, err => console.warn('Test notification listener failed:', err.message));
}
