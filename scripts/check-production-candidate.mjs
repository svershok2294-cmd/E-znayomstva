// Run: node scripts/check-production-candidate.mjs
// Static safety checks only. No network, secrets, deployment, or Firebase writes.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const html = fs.readFileSync('index.html', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
const checks = [
  ['Verified Telegram-to-Firebase login', () => assert.match(html, /signInWithCustomToken\s*\(/)],
  ['Production auth URL', () => assert.match(html, /https:\/\/e-znayomstva-auth\.onrender\.com\/auth\/telegram/)],
  ['Production message URL', () => assert.match(html, /https:\/\/e-znayomstva-auth\.onrender\.com\/api\/moves/)],
  ['Firebase ID token on each send', () => assert.match(html, /currentUser\.getIdToken\s*\(/)],
  ['Server message helper used for initial moves and replies', () => assert.ok((html.match(/submitMoveViaServer\s*\(/g) || []).length >= 3)],
  ['No client direct message create', () => assert.doesNotMatch(html, /collection\s*\(\s*['"]ez_moves['"]\s*\)\s*\.\s*(?:add|doc\s*\([^)]*\)\s*\.\s*(?:set|create))\s*\(/)],
  ['No client-side bypass switch', () => assert.doesNotMatch(html, /USE_TEST_SERVER_MOVES|serverMoves=0|rateCheck=1|antispamCheck=1/)],
  ['No test auth URL', () => assert.doesNotMatch(html, /e-znayomstva-test-auth\.onrender\.com/)],
  ['Production server flag', () => assert.match(server, /process\.env\.ENABLE_SERVER_MOVES === 'true'/)],
  ['No test server flag', () => assert.doesNotMatch(server, /ENABLE_TEST_SERVER_MOVES/)],
  ['Server verifies Firebase ID token', () => assert.match(server, /verifyIdToken\s*\(\s*idToken\s*,\s*true\s*\)/)],
  ['Server enforces five-second rate limit', () => assert.match(server, /5000\s*-\s*\(Date\.now\(\)\s*-\s*previous\)/)],
  ['Server checks mutual blocks', () => assert.match(server, /block1\.exists\s*\|\|\s*block2\.exists/)],
  ['Production origin permitted', () => assert.match(server, /https:\/\/svershok2294-cmd\.github\.io/)],
  ['Test origin not explicitly allowed', () => assert.doesNotMatch(server, /e-znayomstva-test\.onrender\.com/)],
  ['Production notifications opt-in only', () => assert.match(server, /process\.env\.ENABLE_PRODUCTION_MOVE_NOTIFICATIONS === 'true'/)],
  ['Production notification button opens main site', () => assert.match(server, /web_app:\s*\{\s*url:\s*'https:\/\/svershok2294-cmd\.github\.io\/E-znayomstva\/'/)],
  ['No test bot notification or polling flags', () => assert.doesNotMatch(server, /ENABLE_TEST_MOVE_NOTIFICATIONS|ENABLE_TEST_BOT_WELCOME/)],
  ['Notification delivery has receipt deduplication', () => assert.match(server, /await receipt\.create\s*\(/)],
  ['Notification text does not include message content', () => assert.doesNotMatch(server, /text:\s*move\.myReply|text:\s*move\.message/)]
];
let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
console.log(checks.length - failed + '/' + checks.length + ' static checks passed.');
if (failed) process.exitCode = 1;
console.log('NOTE: static checks do not prove runtime functionality or deployment readiness.');
