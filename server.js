import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Browser Origin for GitHub Pages contains only scheme + host (no repo path).
// Candidate production service accepts only the production web origin by default.
// APP_ORIGIN is optional and must be an exact, trusted HTTPS origin.
const ALLOWED_ORIGINS = new Set([
  'https://svershok2294-cmd.github.io',
  ...(process.env.APP_ORIGIN && /^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(process.env.APP_ORIGIN)
    ? [process.env.APP_ORIGIN] : [])
]);
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

// Server-owned message creation. Candidate-only: production requires explicit ENABLE_SERVER_MOVES=true.
async function createRateLimitedMove(body, idToken) {
  if (!firebaseReady) return { status: 503, body: { error: 'Firebase unavailable' } };
  const decoded = await getAuth().verifyIdToken(idToken, true);
  if (!/^telegram:[0-9]+$/.test(decoded.uid)) return { status: 401, body: { error: 'Invalid account' } };
  const sender = decoded.uid.slice('telegram:'.length);
  const recipient = String(body.targetUserId || '');
  const message = body.myReply;
  if (!/^[0-9]+$/.test(recipient) || recipient === sender ||
      typeof message !== 'string' || !message.trim() || message.length > 1000) {
    return { status: 400, body: { error: 'Invalid recipient or message' } };
  }
  const firestore = getFirestore();
  const limitRef = firestore.collection('ez_message_limits').doc(sender + '_' + recipient);
  const users = firestore.collection('ez_users');
  const senderRef = users.doc(sender);
  const userRef = users.doc(recipient);
  const blockedBySender = firestore.collection('ez_blocks').doc(sender).collection('users').doc(recipient);
  const blockedByRecipient = firestore.collection('ez_blocks').doc(recipient).collection('users').doc(sender);
  const now = Date.now();
  const result = await firestore.runTransaction(async tx => {
    // All reads precede all writes. Firestore retries this transaction on contention.
    const [limit, senderProfile, user, block1, block2] = await tx.getAll(
      limitRef, senderRef, userRef, blockedBySender, blockedByRecipient
    );
    if (senderProfile.exists && senderProfile.data().isBanned === true) {
      return { status: 403, body: { error: 'Sender unavailable' } };
    }
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
  const origin = req.headers.origin || '';
  const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : '';
  if (req.url === '/health' && req.method === 'GET') return send(res, 200, { ok: true, configured: Boolean(BOT_TOKEN), firebaseReady });
  if (req.url === '/api/moves' && process.env.ENABLE_SERVER_MOVES === 'true') {
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
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'Invalid body' }, corsOrigin);
      }
      try {
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Invalid body' }, corsOrigin);
        const result = await createRateLimitedMove(body, authorization.slice(7));
        return send(res, result.status, result.body, corsOrigin);
      } catch (error) {
        if (error.code?.startsWith?.('auth/')) return send(res, 401, { error: 'Invalid authentication' }, corsOrigin);
        console.error('Move endpoint:', error.code || error.message);
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


// Production notification candidate. Disabled by default; must be reviewed and explicitly enabled.
// This sends only a generic notification (no message text or sender identity).
// Telegram user must have started the configured production bot to receive it.
if (process.env.ENABLE_PRODUCTION_MOVE_NOTIFICATIONS === 'true' && firebaseReady && BOT_TOKEN) {
  const firestore = getFirestore();
  const receipts = firestore.collection('ez_production_notification_receipts');
  const seen = new Set();
  let initialized = false;

  async function notifyNewMove(change) {
    if (change.type !== 'added' || seen.has(change.doc.id)) return;
    seen.add(change.doc.id);
    const move = change.doc.data() || {};
    const recipient = String(move.targetUserId || '');
    const sender = String(move.fromUserId || '');
    if (!/^[0-9]+$/.test(recipient) || !/^[0-9]+$/.test(sender) || recipient === sender) return;
    const receipt = receipts.doc(change.doc.id);
    try {
      await receipt.create({ recipient, createdAt: Date.now(), status: 'pending' });
    } catch (error) {
      if (error.code === 6 || error.code === 'already-exists') return;
      console.warn('Production notification receipt error:', error.code || error.message);
      return;
    }
    try {
      const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: recipient,
          text: '💌 Нове повідомлення в «Е-Знайомства»!\n\n♞ Відкрийте застосунок, щоб прочитати та відповісти.',
          reply_markup: { inline_keyboard: [[{
            text: '💬 Відкрити Е-Знайомства',
            web_app: { url: 'https://svershok2294-cmd.github.io/E-znayomstva/' }
          }]] }
        }),
        signal: AbortSignal.timeout(10000)
      });
      const result = await response.json();
      if (!result.ok) throw new Error('Telegram HTTP ' + (result.error_code || response.status));
      await receipt.update({ status: 'sent', sentAt: Date.now() });
    } catch (error) {
      // Do not automatically retry ambiguous failures; Telegram may already have delivered.
      console.warn('Production notification not confirmed:', error.message);
    }
  }

  firestore.collection('ez_moves').orderBy('createdAt', 'desc').limit(100).onSnapshot(snapshot => {
    if (!initialized) {
      for (const doc of snapshot.docs) seen.add(doc.id);
      initialized = true;
      console.log('Production notifications initialized; historical moves ignored');
      return;
    }
    for (const change of snapshot.docChanges()) void notifyNewMove(change);
    if (seen.size > 5000) seen.clear();
  }, error => console.warn('Production notification listener:', error.message));
}
