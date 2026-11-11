// Isolated behavioral tests for the candidate swipe flow. No Firebase/network access.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('let profileMovePending = false;');
const end = html.indexOf('function banFromSwipe()', start);
assert.ok(start >= 0 && end > start, 'Swipe function must be present');
const source = html.slice(start, end);

function setup(send) {
  const card = { style: { opacity: '1' } };
  const alerts = [], timers = [], cooldown = new Map(), storage = new Map();
  let renders = 0;
  const context = {
    document: { getElementById: () => card },
    verifiedTelegramUser: { id: 123 },
    isFirebaseConnected: true,
    db: {},
    profiles: [{ docId: '456' }],
    currentIndex: 0,
    warnMessageCooldown: () => false,
    lastMessageTimes: cooldown,
    recordMessageSent: id => cooldown.set(id, 1000),
    submitMoveViaServer: send,
    localStorage: {
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    alert: message => alerts.push(message),
    console: { warn: () => {} },
    setTimeout: fn => { timers.push(fn); return timers.length; },
    renderCard: () => { renders++; }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, card, alerts, timers, cooldown, storage, get renders() { return renders; } };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

{
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  let sends = 0;
  const t = setup(() => { sends++; return pending; });
  const first = t.context.nextProfile(true, 'Привіт');
  await t.context.nextProfile(true, 'Повтор');
  assert.equal(sends, 1, 'Repeated tap must not send twice');
  assert.equal(t.card.style.opacity, '1', 'Card must remain until server confirms');
  assert.equal(t.timers.length, 0, 'No animation before server confirms');
  resolve({ ok: true });
  await first;
  assert.equal(t.card.style.opacity, '0', 'Card animates after success');
  assert.equal(t.timers.length, 1);
  t.timers.shift()();
  assert.equal(t.context.currentIndex, 1);
  t.timers.shift()();
  assert.equal(t.renders, 1);
  console.log('PASS successful send and duplicate-tap lock');
}
{
  const t = setup(async () => { throw new Error('Server unavailable'); });
  t.cooldown.set('456', 500);
  t.storage.set('ez_last_message_123_456', '500');
  await t.context.nextProfile(true, 'Привіт');
  assert.equal(t.context.currentIndex, 0, 'Failed send must not skip profile');
  assert.equal(t.card.style.opacity, '1', 'Failed send must keep card visible');
  assert.equal(t.timers.length, 0, 'Failed send must not animate');
  assert.equal(t.cooldown.get('456'), 500, 'Previous cooldown must be restored');
  assert.equal(t.storage.get('ez_last_message_123_456'), '500');
  assert.equal(t.alerts.length, 1);
  console.log('PASS failed send keeps profile and restores cooldown');
}
{
  const t = setup(async () => { throw Error('Should not send'); });
  t.context.verifiedTelegramUser = null;
  await t.context.nextProfile(true, 'Привіт');
  assert.equal(t.context.currentIndex, 0);
  assert.equal(t.card.style.opacity, '1');
  assert.equal(t.alerts.length, 1);
  console.log('PASS unauthenticated send is blocked');
}
console.log('3/3 candidate swipe behavior tests passed.');

{
  const authStart = html.indexOf('const TEST_APP_HOST');
  const authEnd = html.indexOf('// --- АВТОРИЗАЦІЯ TELEGRAM ---', authStart);
  assert.ok(authStart >= 0 && authEnd > authStart, 'Test Firebase initialization must be present');
  const source = html.slice(authStart, authEnd);

  for (const [hostname, projectId, expectedRequests] of [
    ['svershok2294-cmd.github.io', 'demo-e-znayomstva', []],
    ['e-znayomstva-test.onrender.com', 'nazviazku', ['/firebase-config']],
    ['e-znayomstva-test.onrender.com', 'nazviazku-38b50', ['/firebase-config']]
  ]) {
    const requests = [];
    let initialized = false;
    const context = vm.createContext({
      location: { hostname },
      tg: { initData: 'synthetic-telegram-data' },
      document: { getElementById: () => null },
      console: { warn() {} },
      firebase: { initializeApp() { initialized = true; } },
      async fetch(url) {
        requests.push(new URL(url).pathname);
        return {
          ok: true,
          json: async () => ({
            projectId, authDomain: projectId + '.firebaseapp.com', apiKey: 'test', appId: 'test'
          })
        };
      }
    });
    await vm.runInContext(source + '\nauthenticateTelegram();', context);
    assert.equal(initialized, false);
    assert.deepEqual(requests, expectedRequests);
  }
  console.log('PASS non-test host and production Firebase projects are blocked before sign-in');
}
