import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { deleteApp as deleteClientApp, initializeApp as initializeClientApp } from 'firebase/app';
import { connectAuthEmulator, getAuth as getClientAuth, signInAnonymously, signInWithCustomToken } from 'firebase/auth';

const botToken = 'synthetic-telegram-test-token';
const projectId = 'demo-e-znayomstva';

function signedInitData(id, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    user: JSON.stringify({ id, first_name: 'Test' })
  });
  const data = [...params].map(([key, value]) => key + '=' + value).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(data).digest('hex'));
  return params;
}

test('Telegram login issues a Firebase session that can send moves over HTTP', async () => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8088');
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9099');
  const app = initializeApp({ projectId });
  const adminAuth = getAuth(app);
  const clientApp = initializeClientApp({ projectId, apiKey: 'synthetic-test-key' });
  const clientAuth = getClientAuth(clientApp);
  connectAuthEmulator(clientAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  const origin = 'https://e-znayomstva-test.onrender.com';
  let server;
  try {
    const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const start = source.indexOf('function loadTestFirebaseConfig(');
    const end = source.indexOf('\nserver.listen(', start);
    assert.ok(start >= 0 && end > start, 'Message handler not found');

    const publicConfig = {
      projectId,
      apiKey: 'synthetic-test-key',
      appId: 'synthetic-test-app',
      authDomain: projectId + '.firebaseapp.com'
    };
    const config = {
      FIREBASE_TEST_PROJECT_ID: projectId,
      FIREBASE_TEST_WEB_CONFIG: JSON.stringify({ ...publicConfig, ignored: 'private' }),
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: projectId })
    };
    const context = vm.createContext({
      http,
      console: { log() {}, warn() {}, error() {} },
      process: { env: config },
      ALLOWED_ORIGINS: new Set([origin]),
      parseServiceAccount: JSON.parse,
      cert: value => value,
      initializeApp: options => assert.equal(options.projectId, projectId),
      BOT_TOKEN: botToken,
      ADMIN_TELEGRAM_ID: '703',
      MAX_AGE_SECONDS: 300,
      crypto,
      Buffer,
      URLSearchParams,
      getAuth: () => adminAuth,
      getFirestore: () => ({
        collection: name => db.collection(name),
        // Return a Promise from the same realm as the Firestore SDK.
        runTransaction: callback => db.runTransaction(async tx => callback(tx))
      })
    });
    server = vm.runInContext(source.slice(start, end) + '\nserver;', context);
    for (const id of ['nazviazku', 'nazviazku-38b50', '']) {
      assert.throws(() => context.loadTestFirebaseConfig({ ...config, FIREBASE_TEST_PROJECT_ID: id }),
        /isolated Firebase project/);
    }
    assert.throws(() => context.loadTestFirebaseConfig({
      ...config, FIREBASE_TEST_WEB_CONFIG: JSON.stringify({ ...publicConfig, projectId: 'other-project' })
    }), /Invalid test Firebase web configuration/);
    const bootstrap = source.slice(start, source.indexOf('function send(res,', start));
    const mismatched = vm.runInNewContext(bootstrap + '\nfirebaseReady;', {
      ...context,
      process: { env: { ...config, FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"nazviazku"}' } },
      initializeApp: () => assert.fail('A mismatched service account must never initialize Firebase')
    });
    assert.equal(mismatched, false);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    const url = baseUrl + '/api/moves';
    const configResponse = await fetch(baseUrl + '/firebase-config', { headers: { Origin: origin } });
    assert.equal(configResponse.status, 200);
    assert.deepEqual(await configResponse.json(), publicConfig);
    const deniedConfig = await fetch(baseUrl + '/firebase-config', {
      headers: { Origin: 'https://svershok2294-cmd.github.io' }
    });
    assert.equal(deniedConfig.status, 403);
    const login = initData => fetch(baseUrl + '/auth/telegram', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: initData.toString() }),
      signal: AbortSignal.timeout(10000)
    });

    const tampered = signedInitData(701);
    tampered.set('user', JSON.stringify({ id: 703 }));
    assert.equal((await login(tampered)).status, 401);
    assert.equal((await login(signedInitData(701, Math.floor(Date.now() / 1000) - 301))).status, 401);

    const moderatorLogin = await login(signedInitData(703));
    assert.equal(moderatorLogin.status, 200);
    const moderator = await signInWithCustomToken(clientAuth, (await moderatorLogin.json()).token);
    assert.equal((await moderator.user.getIdTokenResult()).claims.admin, true);

    const loginResponse = await login(signedInitData(701));
    assert.equal(loginResponse.status, 200);
    const session = await loginResponse.json();
    assert.equal(session.verified, true);
    assert.equal(session.user.id, 701);
    const { user } = await signInWithCustomToken(clientAuth, session.token);
    assert.equal(user.uid, 'telegram:701');
    const idToken = await user.getIdToken();
    const decoded = await adminAuth.verifyIdToken(idToken, true);
    assert.equal(decoded.firebase.sign_in_provider, 'custom');
    assert.equal(decoded.admin, undefined);
    const post = (body, headers = {}) => fetch(url, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + idToken,
        ...headers
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    await db.doc('ez_users/702').set({ name: 'Synthetic recipient' });

    const message = { targetUserId: '702', myReply: 'Synthetic message' };
    const send = () => post(message);
    assert.equal((await send()).status, 404);
    context.process.env.ENABLE_TEST_SERVER_MOVES = 'true';

    const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/i);
    assert.equal((await post(message, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await post(message, { Authorization: '' })).status, 401);
    const invalidToken = await post(message, { Authorization: 'Bearer invalid-token' });
    assert.equal(invalidToken.status, 401);
    assert.equal((await invalidToken.json()).code, 'FIREBASE_SESSION_INVALID');
    for (const body of ['{', null, [], { ...message, targetUserId: '701' }]) {
      assert.equal((await post(body)).status, 400);
    }

    await clientAuth.signOut();
    const anonymous = await signInAnonymously(clientAuth);
    const anonymousToken = await anonymous.user.getIdToken();
    assert.equal((await post(message, { Authorization: 'Bearer ' + anonymousToken })).status, 401);

    await db.doc('ez_users/701').set({ isBanned: true });
    assert.equal((await send()).status, 403);
    await db.doc('ez_users/701').update({ isBanned: false });

    await db.doc('ez_users/702').update({ isBanned: true });
    assert.equal((await send()).status, 404);
    await db.doc('ez_users/702').update({ isBanned: false });

    for (const path of ['ez_blocks/701/users/702', 'ez_blocks/702/users/701']) {
      const block = db.doc(path);
      await block.set({ blockedAt: Date.now() });
      assert.equal((await send()).status, 403);
      await block.delete();
    }

    const results = await Promise.all([send(), send()]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 429]);
    const cooldown = results.find(result => result.status === 429);
    const { retryAfterSeconds } = await cooldown.json();
    assert.ok(retryAfterSeconds >= 1 && retryAfterSeconds <= 5);
    const created = results.find(result => result.status === 201);
    assert.equal(created.headers.get('access-control-allow-origin'), origin);
    const { ok, moveId } = await created.json();
    assert.equal(ok, true);

    const messages = await db.collection('ez_moves').where('fromUserId', '==', '701').get();
    assert.equal(messages.size, 1);
    assert.equal(messages.docs[0].id, moveId);
    assert.equal(messages.docs[0].data().targetUserId, '702');
    const limit = await db.doc('ez_message_limits/701_702').get();
    assert.equal(typeof limit.data()?.lastSentAt, 'number');
  } finally {
    if (server?.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await deleteClientApp(clientApp);
    await db.terminate();
    await deleteApp(app);
  }
});
