import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, deleteField, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, runTransaction, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';
import { deleteApp, initializeApp } from 'firebase/app';
import * as firestoreLite from 'firebase/firestore/lite';

let env;
const projectId = 'demo-e-znayomstva';
const telegram = (id, claims = {}) => env.authenticatedContext('telegram:' + id, {
  firebase: { sign_in_provider: 'custom' }, ...claims
}).firestore();
const recentMoves = (db, field, id) => query(
  collection(db, 'ez_moves'), where(field, '==', id), orderBy('createdAt', 'desc'), limit(30)
);
const profile = id => ({
  id: '#' + id.slice(-4), tgId: id, username: 'test_user', name: 'Test, 25',
  city: 'Test city', img: '', tags: ['Chess'], question: 'Question?',
  answer: 'Answer', icebreakers: ['Hello'], isVip: false, isBanned: false,
  trustScore: 0, trustLabel: 'Новий профіль', createdAt: Date.now(),
  registrationRewardGranted: false
});

before(async () => {
  if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8088') {
    throw new Error('Start the local emulator with npm run test:rules');
  }
  env = await initializeTestEnvironment({
    projectId,
    firestore: { rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8') }
  });
});
after(async () => env?.cleanup());
beforeEach(async () => env.clearFirestore());

test('profile registration, feed query and owner edits preserve existing metadata', async () => {
  const alice = telegram('101');
  const bob = telegram('202');
  const ref = doc(alice, 'ez_users/101');
  await assertSucceeds(runTransaction(alice, async tx => {
    const existing = await tx.get(ref);
    if (!existing.exists()) tx.set(ref, profile('101'));
  }));
  const feed = db => query(collection(db, 'ez_users'), orderBy('createdAt', 'desc'), limit(50));
  await assertSucceeds(getDocs(feed(bob)));
  await assertFails(getDocs(feed(env.unauthenticatedContext().firestore())));
  await assertFails(getDocs(feed(telegram('101', { firebase: { sign_in_provider: 'anonymous' } }))));
  await assertFails(getDoc(doc(env.authenticatedContext('101').firestore(), 'ez_users/101')));
  await env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), 'ez_users/101'), { legacyField: true }));
  await assertSucceeds(runTransaction(alice, async tx => {
    const existing = await tx.get(ref);
    if (existing.exists()) tx.update(ref, { name: 'Updated, 25' });
  }));
  await assertFails(updateDoc(doc(bob, 'ez_users/101'), { name: 'Hijacked' }));
  await assertFails(deleteDoc(ref));
});

test('profile validation rejects forged IDs, privileges, timestamps and malformed content', async () => {
  const alice = telegram('101');
  const ref = doc(alice, 'ez_users/101');
  const base = profile('101');
  await assertFails(setDoc(doc(alice, 'ez_users/202'), profile('202')));
  for (const patch of [
    { tgId: '202' }, { admin: true }, { isVip: true }, { isBanned: true },
    { trustScore: 99 }, { registrationRewardGranted: true },
    { createdAt: 1 }, { createdAt: Date.now() + 3600000 }, { username: 'x'.repeat(33) },
    { tags: [...Array(11).fill('Chess'), 42] }, { icebreakers: ['x'.repeat(301)] }
  ]) await assertFails(setDoc(ref, { ...base, ...patch }));
  await assertSucceeds(setDoc(ref, base));
  for (const patch of [
    { tgId: '202' }, { createdAt: Date.now() }, { tags: ['x'.repeat(81)] },
    { img: 'x'.repeat(750001) }, { name: 42 }, { name: deleteField() }, { extra: true }
  ]) await assertFails(updateDoc(ref, patch));
});

test('moderation is claim-gated and limited to ban fields', async () => {
  const alice = telegram('101');
  const moderator = telegram('303', { admin: true });
  const ref = doc(alice, 'ez_users/101');
  const modRef = doc(moderator, 'ez_users/101');
  await assertSucceeds(setDoc(ref, profile('101')));
  await assertFails(updateDoc(ref, { isBanned: true }));
  await assertFails(updateDoc(modRef, { isBanned: 'true' }));
  await assertFails(updateDoc(modRef, { isBanned: true, tgId: '303' }));
  await assertFails(updateDoc(modRef, { reason: 'x'.repeat(251) }));
  await assertSucceeds(updateDoc(modRef, { isBanned: true, reason: 'Spam' }));
  await assertFails(updateDoc(ref, { name: 'Still banned' }));
  await assertSucceeds(updateDoc(modRef, { isBanned: false }));
});

test('message queries allow participants including legacy outbound messages', async () => {
  const alice = telegram('101');
  const bob = telegram('202');
  const third = telegram('303');
  const message = { fromUserId: '101', targetUserId: '202', myReply: 'Hello', createdAt: Date.now() };
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'ez_moves/current'), message);
    await setDoc(doc(db, 'ez_moves/legacy'), { fromUserId: '101', myReply: 'Legacy' });
  });
  const inbox = (db, field, id) => getDocs(query(collection(db, 'ez_moves'), where(field, '==', id), limit(30)));
  await assertSucceeds(inbox(alice, 'fromUserId', '101'));
  await assertSucceeds(inbox(bob, 'targetUserId', '202'));
  await assertSucceeds(getDoc(doc(bob, 'ez_moves/current')));
  await assertFails(getDoc(doc(third, 'ez_moves/current')));
  await assertFails(inbox(third, 'fromUserId', '101'));
  await assertFails(getDocs(collection(alice, 'ez_moves')));
  await assertFails(setDoc(doc(alice, 'ez_moves/forged'), message));
  await assertFails(updateDoc(doc(alice, 'ez_moves/current'), { myReply: 'Edited' }));
  await assertFails(deleteDoc(doc(bob, 'ez_moves/current')));
});

test('blocks and read receipts enforce ownership and monotonic receipt timestamps', async () => {
  const alice = telegram('101');
  const bob = telegram('202');
  const third = telegram('303');
  const block = doc(alice, 'ez_blocks/101/users/202');
  await assertFails(setDoc(doc(bob, 'ez_blocks/101/users/202'), { blockedAt: Date.now() }));
  await assertFails(setDoc(doc(alice, 'ez_blocks/101/users/101'), { blockedAt: Date.now() }));
  await assertSucceeds(setDoc(block, { blockedAt: Date.now() }));
  await assertSucceeds(getDocs(collection(alice, 'ez_blocks/101/users')));
  await assertFails(getDocs(collection(bob, 'ez_blocks/101/users')));
  await assertFails(updateDoc(block, { blockedAt: Date.now() }));
  await assertSucceeds(deleteDoc(block));
  const path = 'ez_chat_reads/101_202';
  const receipt = doc(alice, path);
  const seenAt = Date.now();
  await assertSucceeds(getDoc(doc(bob, path)));
  await assertFails(setDoc(doc(bob, path), { recipientId: '101', senderId: '202', seenAt }));
  await assertFails(setDoc(doc(alice, 'ez_chat_reads/101_303'), { recipientId: '101', senderId: '202', seenAt }));
  await assertSucceeds(setDoc(receipt, { recipientId: '101', senderId: '202', seenAt }, { merge: true }));
  await assertSucceeds(getDoc(doc(bob, path)));
  await assertFails(getDoc(doc(third, path)));
  await assertFails(getDocs(collection(alice, 'ez_chat_reads')));
  await assertFails(updateDoc(receipt, { seenAt: seenAt - 1 }));
  await assertFails(updateDoc(receipt, { seenAt: seenAt + 3600000 }));
  await assertSucceeds(updateDoc(receipt, { seenAt: seenAt + 1 }));
});

test('reports are validated and moderation-only, internal collections deny all clients', async () => {
  const alice = telegram('101');
  const moderator = telegram('303', { admin: true });
  const report = { name: 'Profile', reason: 'Spam', text: 'Test report', img: '', createdAt: Date.now() };
  const path = 'ez_reports/report';
  await assertFails(setDoc(doc(alice, path), { ...report, text: 42 }));
  await assertFails(setDoc(doc(alice, path), { ...report, img: deleteField() }, { merge: true }));
  await assertFails(setDoc(doc(alice, path), { ...report, text: 'x'.repeat(1201) }));
  await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), path), report));
  await assertSucceeds(setDoc(doc(alice, path), report));
  await assertFails(getDoc(doc(alice, path)));
  await assertFails(getDocs(collection(alice, 'ez_reports')));
  await assertSucceeds(getDocs(query(collection(moderator, 'ez_reports'), orderBy('createdAt', 'desc'), limit(30))));
  await assertFails(updateDoc(doc(moderator, path), { text: 'Rewritten' }));
  await assertSucceeds(deleteDoc(doc(moderator, path)));
  for (const internal of ['ez_stats/global_cashbox', 'ez_message_limits/101_202', 'ez_test_notification_receipts/example']) {
    await assertFails(getDoc(doc(moderator, internal)));
    await assertFails(setDoc(doc(moderator, internal), { value: true }));
  }
});

function firstServerSnapshot(ref, matches = () => true) {
  return new Promise((resolve, reject) => {
    const unsubscribe = onSnapshot(ref, { includeMetadataChanges: true }, snapshot => {
      if (snapshot.metadata.fromCache || !matches(snapshot)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(snapshot);
    }, error => {
      clearTimeout(timeout);
      unsubscribe();
      reject(error);
    });
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for a Firestore server snapshot'));
    }, 5000);
  });
}

test('live feed, chat and moderation listeners enforce the same access as reads', async () => {
  const alice = telegram('101');
  const bob = telegram('202');
  const third = telegram('303');
  const moderator = telegram('303', { admin: true });
  const guest = env.unauthenticatedContext().firestore();
  const feed = db => query(collection(db, 'ez_users'), orderBy('createdAt', 'desc'), limit(50));
  const reports = db => query(collection(db, 'ez_reports'), orderBy('createdAt', 'desc'), limit(30));

  await assert.rejects(firstServerSnapshot(feed(guest)), { code: 'permission-denied' });
  await assert.rejects(firstServerSnapshot(recentMoves(third, 'targetUserId', '202')), { code: 'permission-denied' });
  await assert.rejects(firstServerSnapshot(collection(bob, 'ez_blocks/101/users')), { code: 'permission-denied' });
  await assert.rejects(firstServerSnapshot(reports(alice)), { code: 'permission-denied' });

  const pending = Promise.all([
    firstServerSnapshot(feed(bob), snapshot => snapshot.size === 1),
    firstServerSnapshot(recentMoves(alice, 'fromUserId', '101'), snapshot => snapshot.size === 1),
    firstServerSnapshot(recentMoves(bob, 'targetUserId', '202'), snapshot => snapshot.size === 1),
    firstServerSnapshot(collection(alice, 'ez_blocks/101/users'), snapshot => snapshot.size === 1),
    firstServerSnapshot(reports(moderator), snapshot => snapshot.size === 1)
  ]);
  const [, , snapshots] = await Promise.all([
    env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      await Promise.all([
        setDoc(doc(db, 'ez_users/101'), profile('101')),
        setDoc(doc(db, 'ez_moves/message'), {
          fromUserId: '101', targetUserId: '202', myReply: 'Hello', createdAt: Date.now()
        }),
        setDoc(doc(db, 'ez_reports/report'), { createdAt: Date.now() })
      ]);
    }),
    setDoc(doc(alice, 'ez_blocks/101/users/202'), { blockedAt: Date.now() }),
    pending
  ]);
  assert.deepEqual(snapshots.map(snapshot => snapshot.docs[0].id), ['101', 'message', 'message', '202', 'report']);
});

test('live receipt subscription works before the document exists and receives the recipient update', async () => {
  const alice = telegram('101');
  const bob = telegram('202');
  const third = telegram('303');
  const path = 'ez_chat_reads/202_101';

  await assert.rejects(firstServerSnapshot(doc(third, path)), { code: 'permission-denied' });
  assert.equal((await firstServerSnapshot(doc(alice, path))).exists(), false);

  const seenAt = Date.now();
  const [snapshot] = await Promise.all([
    firstServerSnapshot(doc(alice, path), current => current.exists()),
    setDoc(doc(bob, path), { recipientId: '202', senderId: '101', seenAt }, { merge: true })
  ]);
  assert.equal(snapshot.data().seenAt, seenAt);
});

test('chat queries return the newest 30 moves in each direction', async t => {
  // Use the REST transport for the large result set. The separate listener test
  // covers updates over streams, which can hit firebase-tools issue #8654.
  function recentMovesOverRest(field, id) {
    const app = initializeApp({ projectId }, 'recent-moves-' + id);
    t.after(() => deleteApp(app));
    const db = firestoreLite.getFirestore(app);
    firestoreLite.connectFirestoreEmulator(db, '127.0.0.1', 8088, {
      mockUserToken: {
        sub: 'telegram:' + id,
        firebase: { sign_in_provider: 'custom' }
      }
    });
    return firestoreLite.query(
      firestoreLite.collection(db, 'ez_moves'),
      firestoreLite.where(field, '==', id),
      firestoreLite.orderBy('createdAt', 'desc'),
      firestoreLite.limit(30)
    );
  }

  const sent = recentMovesOverRest('fromUserId', '101');
  const received = recentMovesOverRest('targetUserId', '202');
  const move = { fromUserId: '101', targetUserId: '202', myReply: 'Hello' };
  const start = Date.now() - 1000;

  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const batch = writeBatch(db);
    for (let index = 0; index < 31; index++) {
      const id = 'message-' + String(index).padStart(2, '0');
      batch.set(doc(db, 'ez_moves', id), { ...move, createdAt: start + index });
    }
    await batch.commit();
  });

  const expected = Array.from({ length: 30 }, (_, index) =>
    'message-' + String(30 - index).padStart(2, '0')
  );
  for (const ref of [sent, received]) {
    const snapshot = await firestoreLite.getDocs(ref);
    assert.deepEqual(snapshot.docs.map(doc => doc.id), expected);
  }

  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'ez_moves/z-new'), {
    ...move, createdAt: start + 31
  }));
  const snapshot = await firestoreLite.getDocs(received);
  assert.deepEqual(snapshot.docs.map(doc => doc.id), ['z-new', ...expected.slice(0, 29)]);
});
