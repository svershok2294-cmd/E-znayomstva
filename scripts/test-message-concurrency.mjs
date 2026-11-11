import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

test('concurrent messages create one document and enforce the cooldown', async () => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8088');
  const app = initializeApp({ projectId: 'demo-e-znayomstva' });
  const db = getFirestore(app);
  try {
    const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const start = source.indexOf('async function createRateLimitedMove(');
    const end = source.indexOf('\nconst server = http.createServer(', start);
    assert.ok(start >= 0 && end > start, 'Message handler not found');

    const context = vm.createContext({
      firebaseReady: true,
      getAuth: () => ({ verifyIdToken: async () => ({ uid: 'telegram:701' }) }),
      getFirestore: () => ({
        collection: name => db.collection(name),
        // Return a Promise from the same realm as the Firestore SDK.
        runTransaction: callback => db.runTransaction(async tx => callback(tx))
      })
    });
    vm.runInContext(source.slice(start, end), context);
    await db.doc('ez_users/702').set({ name: 'Synthetic recipient' });

    const send = () => context.createRateLimitedMove({
      targetUserId: '702',
      myReply: 'Synthetic message'
    }, 'synthetic-token');
    const attempts = await Promise.allSettled([send(), send()]);
    for (const attempt of attempts) {
      if (attempt.status === 'rejected') throw attempt.reason;
    }
    const results = attempts.map(attempt => attempt.value);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 429]);
    const cooldown = results.find(result => result.status === 429);
    assert.ok(cooldown.body.retryAfterSeconds >= 1 && cooldown.body.retryAfterSeconds <= 5);

    const messages = await db.collection('ez_moves').where('fromUserId', '==', '701').get();
    assert.equal(messages.size, 1);
    assert.equal(messages.docs[0].data().targetUserId, '702');
    const limit = await db.doc('ez_message_limits/701_702').get();
    assert.equal(typeof limit.data()?.lastSentAt, 'number');
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
});
