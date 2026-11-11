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

// Security regression cases: all must refuse the request without creating a move.
const moveCount = () => [...docs.keys()].filter(x => x.startsWith('ez_moves/')).length;
const countBefore = moveCount();
const invalid = await context.createRateLimitedMove({ targetUserId: '456', myReply: '   ' }, 'fake-test-token');
assert.equal(invalid.status, 400, 'Blank message must be rejected');
const oversized = await context.createRateLimitedMove({ targetUserId: '456', myReply: 'x'.repeat(1001) }, 'fake-test-token');
assert.equal(oversized.status, 400, 'Oversized message must be rejected');
const selfSend = await context.createRateLimitedMove({ targetUserId: '123', myReply: 'self' }, 'fake-test-token');
assert.equal(selfSend.status, 400, 'Self-send must be rejected');
const missing = await context.createRateLimitedMove({ targetUserId: '789', myReply: 'hello' }, 'fake-test-token');
assert.equal(missing.status, 404, 'Unknown recipient must be rejected');
docs.set('ez_blocks/123/users/456', { blockedAt: Date.now() });
const blocked = await context.createRateLimitedMove(body, 'fake-test-token');
assert.equal(blocked.status, 403, 'Sender block must prevent messaging');
docs.delete('ez_blocks/123/users/456');
docs.set('ez_blocks/456/users/123', { blockedAt: Date.now() });
const reverseBlocked = await context.createRateLimitedMove(body, 'fake-test-token');
assert.equal(reverseBlocked.status, 403, 'Recipient block must prevent messaging');
docs.delete('ez_blocks/456/users/123');
docs.set('ez_users/456', { name: 'Test recipient', city: 'Test', isBanned: true });
const banned = await context.createRateLimitedMove(body, 'fake-test-token');
assert.equal(banned.status, 404, 'Banned recipient must be unavailable');
assert.equal(moveCount(), countBefore, 'Rejected attempts must not create messages');
console.log('PASS blank, oversized, self-send, missing, blocked (both ways), banned');
console.log('PASS rejected attempts never write messages');
console.log('PASS first message accepted (201)');
console.log('PASS immediate repeat rejected (429) without second Firestore write');
console.log('9/9 server behavior scenarios passed (mocked Firestore transaction).');
