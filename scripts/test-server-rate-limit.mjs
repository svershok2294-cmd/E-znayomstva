import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// Mock Firestore transaction: no credentials, network calls, or writes to real Firebase.
const server = fs.readFileSync('server.js', 'utf8');
const start = server.indexOf('async function createRateLimitedMove(');
const end = server.indexOf('\nconst server = http.createServer(', start);
assert.ok(start >= 0 && end > start, 'Rate-limited move handler not found');
const docs = new Map([['ez_users/456', { name: 'Test recipient', city: 'Test' }]]);
const refs = path => ({
  path,
  collection(name) { return refs(path + '/' + name); },
  doc(id) { return refs(path + '/' + (id || 'generated-move')); }
});
const firestore = {
  collection: name => refs(name),
  async runTransaction(callback) {
    const changes = [];
    const tx = {
      async get(ref) {
        return { exists: docs.has(ref.path), data: () => docs.get(ref.path) };
      },
      create(ref, value) { changes.push([ref.path, value]); },
      set(ref, value) { changes.push([ref.path, { ...docs.get(ref.path), ...value }]); }
    };
    const result = await callback(tx);
    for (const [path, value] of changes) docs.set(path, value);
    return result;
  }
};
const context = {
  firebaseReady: true,
  getAuth: () => ({ verifyIdToken: async () => ({ uid: 'telegram:123' }) }),
  getFirestore: () => firestore,
  Date,
  Number,
  String,
  Promise
};
vm.createContext(context);
vm.runInContext(server.slice(start, end), context);
const body = { targetUserId: '456', myReply: 'Тест серверного таймера' };
const first = await context.createRateLimitedMove(body, 'fake-test-token');
assert.equal(first.status, 201);
assert.equal(docs.has('ez_moves/generated-move'), true);
const second = await context.createRateLimitedMove(body, 'fake-test-token');
assert.equal(second.status, 429);
assert.ok(second.body.retryAfterSeconds >= 1 && second.body.retryAfterSeconds <= 5);
assert.equal([...docs.keys()].filter(x => x.startsWith('ez_moves/')).length, 1);
console.log('PASS first message accepted (201)');
console.log('PASS immediate repeat rejected (429) without second Firestore write');
console.log('2/2 server rate-limit tests passed (mocked transaction).');
