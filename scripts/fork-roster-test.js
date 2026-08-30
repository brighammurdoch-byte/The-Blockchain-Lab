/**
 * Headless checks for the classroom fork roster (51% + hard fork).
 * Usage: node scripts/fork-roster-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadChainDisplay() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public/javascripts/lab/chainDisplay.js'),
    'utf8'
  );
  const ctx = { window: {}, console, document: undefined };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.ForkRoster;
}

const results = [];
function pass(n, d) { results.push({ ok: true, n }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); }
function fail(n, d) { results.push({ ok: false, n }); console.log('FAIL  ' + n + ' — ' + d); }

const FR = loadChainDisplay();
if (!FR) {
  console.log('FAIL  ForkRoster loaded');
  process.exit(1);
}
pass('ForkRoster loaded');

const alice = { userId: 'm1', name: 'Alice', role: 'miner', isColluding: false };
const mallory = { userId: 'm2', displayName: 'Mallory', role: 'miner', isAttacker: true, isColluding: true };
const wallet = { userId: 'w1', name: 'Wallet 1', role: 'wallet' };
const admin = { userId: 'hub', name: 'Instructor', role: 'admin' };
const parts51 = [alice, mallory, wallet, admin];

if (FR.isAttackActive(parts51, null) && !FR.isHardForkActive(null)) {
  pass('51% detected from colluder flags');
} else fail('51% detected from colluder flags', 'attack=' + FR.isAttackActive(parts51, null));

if (FR.attackBucket(mallory, null) === 'attack' && FR.attackBucket(alice, null) === 'canonical') {
  pass('51% buckets Canonical vs Attack');
} else fail('51% buckets Canonical vs Attack', FR.attackBucket(mallory, null) + '/' + FR.attackBucket(alice, null));

const youAdmin = FR.youAreOn({
  participants: parts51,
  selfId: 'hub',
  viewRole: 'admin'
});
if (youAdmin === 'You are viewing Canonical') pass('Admin 51% heading is Canonical', youAdmin);
else fail('Admin 51% heading is Canonical', youAdmin);

const youAttacker = FR.youAreOn({
  participants: parts51,
  selfId: 'm2',
  viewRole: 'miner',
  localColluding: true
});
if (youAttacker === 'You are on Attack') pass('Colluder heading is Attack', youAttacker);
else fail('Colluder heading is Attack', youAttacker);

const html51 = FR.renderHtml({
  participants: parts51,
  selfId: 'hub',
  viewRole: 'admin'
});
if (/Canonical/.test(html51) && /Attack/.test(html51) && /Alice/.test(html51) && /Mallory/.test(html51) && /Wallet/.test(html51)) {
  pass('51% roster lists names and both forks');
} else fail('51% roster lists names and both forks', html51.slice(0, 200));

if (/You are viewing Canonical/.test(html51) && /this view/.test(html51)) {
  pass('51% roster marks Canonical as this view');
} else fail('51% roster marks Canonical as this view');

const classicMiner = { userId: 'm1', name: 'Alice', role: 'miner', forkChoice: 'classic' };
const newMiner = { userId: 'm2', name: 'Bob', role: 'miner', forkChoice: 'new' };
const quietMiner = { userId: 'm3', name: 'Cara', role: 'miner' };
const pending = { height: 20, name: 'Big Block Fork' };
const partsFork = [classicMiner, newMiner, quietMiner, wallet, admin];

if (FR.isHardForkActive(pending) && FR.hardForkBucket(newMiner) === 'new' &&
    FR.hardForkBucket(classicMiner) === 'classic' && FR.hardForkBucket(quietMiner) === 'undecided') {
  pass('Hard-fork buckets classic / new / undecided');
} else fail('Hard-fork buckets classic / new / undecided');

const youFork = FR.youAreOn({
  participants: partsFork,
  pendingFork: pending,
  selfId: 'hub',
  viewRole: 'admin'
});
if (youFork === 'You are viewing Classic') pass('Admin hard-fork heading is Classic', youFork);
else fail('Admin hard-fork heading is Classic', youFork);

const youNew = FR.youAreOn({
  participants: partsFork,
  pendingFork: pending,
  selfId: 'm2',
  viewRole: 'miner',
  localForkChoice: 'new'
});
if (youNew === 'You are on Big Block Fork') pass('New-chain miner heading uses fork name', youNew);
else fail('New-chain miner heading uses fork name', youNew);

const htmlFork = FR.renderHtml({
  participants: partsFork,
  pendingFork: pending,
  selfId: 'hub',
  viewRole: 'admin'
});
if (/Classic/.test(htmlFork) && /Big Block Fork/.test(htmlFork) && /Haven’t chosen yet/.test(htmlFork) && /Cara/.test(htmlFork)) {
  pass('Hard-fork roster lists Classic, named fork, and undecided');
} else fail('Hard-fork roster lists Classic, named fork, and undecided', htmlFork.slice(0, 240));

const hidden = FR.renderHtml({
  participants: [{ userId: 'm1', name: 'Alice', role: 'miner' }],
  selfId: 'hub',
  viewRole: 'admin'
});
if (!hidden) pass('Roster hidden when no 51% or hard fork');
else fail('Roster hidden when no 51% or hard fork', hidden.slice(0, 80));

const failed = results.filter((r) => !r.ok).length;
console.log('\n==== fork-roster-test: ' + (results.length - failed) + '/' + results.length + ' passed ====');
process.exit(failed ? 1 : 0);
