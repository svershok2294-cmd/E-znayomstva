import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, deleteField, doc, getDoc, getDocs, limit, orderBy, query, setDoc, updateDoc, where } from 'firebase/firestore';

let env;
const projectId = 'demo-e-znayomstva';
const telegram = (id, claims = {}) => env.authenticatedContext('telegram:' + id, {
  firebase: { sign_in_provider: 'custom' }, ...claims
}).firestore();
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
  await assertSucceeds(setDoc(ref, profile('101')));
  const feed = db => query(collection(db, 'ez_users'), orderBy('createdAt', 'desc'), limit(50));
  await assertSucceeds(getDocs(feed(bob)));
  await assertFails(getDocs(feed(env.unauthenticatedContext().firestore())));
  await assertFails(getDocs(feed(telegram('101', { firebase: { sign_in_provider: 'anonymous' } }))));
  await assertFails(getDoc(doc(env.authenticatedContext('101').firestore(), 'ez_users/101')));
  await env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), 'ez_users/101'), { legacyField: true }));
  await assertSucceeds(updateDoc(ref, { name: 'Updated, 25' }));
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
  for (const internal of ['ez_stats/global_cashbox', 'ez_message_limits/101_202', 'ez_production_notification_receipts/example']) {
    await assertFails(getDoc(doc(moderator, internal)));
    await assertFails(setDoc(doc(moderator, internal), { value: true }));
  }
});
