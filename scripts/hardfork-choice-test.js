/**
 * Headless checks: miner New Chain click must persist + broadcast a vote.
 * Usage: node scripts/hardfork-choice-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(n, d) { results.push({ ok: true, n }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); }
function fail(n, d) { results.push({ ok: false, n }); console.log('FAIL  ' + n + ' — ' + d); }

const part = fs.readFileSync(path.join(ROOT, 'public/javascripts/lab/participate.js'), 'utf8');
const admin = fs.readFileSync(path.join(ROOT, 'public/javascripts/lab/admin.js'), 'utf8');
const partPug = fs.readFileSync(path.join(ROOT, 'views/lab/participate.pug'), 'utf8');
const adminPug = fs.readFileSync(path.join(ROOT, 'views/lab/admin.pug'), 'utf8');

if (/\$\(document\)[\s\S]*#btnFollowNew/.test(part) &&
    /function applyLocalForkChoice/.test(part) &&
    /function syncForkControlButtons/.test(part)) {
  pass('New Chain click is document-delegated and goes through applyLocalForkChoice');
} else {
  fail('New Chain click is document-delegated and goes through applyLocalForkChoice',
    'missing document bind or applyLocalForkChoice');
}

if (/\$\('#forkControlPanel'\)\.on\(\s*['"]click['"]\s*,\s*['"]#btnFollowNew['"]/.test(part)) {
  fail('Does not bind New Chain on a panel that may not exist yet',
    'still uses #forkControlPanel.on(#btnFollowNew)');
} else {
  pass('Does not bind New Chain on a panel that may not exist yet');
}

if (/ensureForkControlPanel\(\)/.test(part) &&
    /setupEventHandlers\(\)/.test(part) &&
    part.indexOf('ensureForkControlPanel()') < part.indexOf('setupEventHandlers()')) {
  pass('Fork Control panel is created before setupEventHandlers');
} else {
  fail('Fork Control panel is created before setupEventHandlers', 'order wrong');
}

if (/hard-fork-vote[\s\S]*choice:\s*next[\s\S]*userId:\s*userId/.test(part) ||
    /net\.send\(\s*['"]hard-fork-vote['"]\s*,\s*\{\s*choice:\s*next/.test(part)) {
  pass('Vote payload includes choice (and userId)');
} else {
  fail('Vote payload includes choice (and userId)', 'send shape missing');
}

if (/height is not a gate|Safe after activation/.test(part) &&
    !/if\s*\([^)]*pendingForkHeight[^)]*\)\s*return;[\s\S]{0,80}hard-fork-vote/.test(part)) {
  pass('Choice is not dropped after activation height');
} else {
  fail('Choice is not dropped after activation height', 'height gate still present');
}

const voteFn = admin.match(/net\.on\(\s*['"]hard-fork-vote['"][\s\S]*?\n\s*\}\);/);
const voteBody = voteFn ? voteFn[0] : '';
if (voteBody && /forkChoice:\s*choice/.test(voteBody) &&
    /payload\.choice \|\| payload\.forkChoice/.test(voteBody) &&
    /paintAdminForkRoster/.test(voteBody) &&
    /broadcastParticipantsRoster/.test(voteBody) &&
    !/choice = payload\.choice \|\| 'classic'/.test(voteBody)) {
  pass('Hub stores a real vote and repaints / rebroadcasts the roster');
} else {
  fail('Hub stores a real vote and repaints / rebroadcasts the roster',
    voteBody ? voteBody.slice(0, 220) : 'no handler');
}

if (/pendingFork = \{ height: h, name: n \}/.test(admin) &&
    /\$height\.val\(h\)\.data\(\s*['"]userEdited['"]\s*,\s*true\)/.test(admin)) {
  pass('Propose Hard Fork freezes the activation-height field');
} else {
  fail('Propose Hard Fork freezes the activation-height field', 'userEdited freeze missing');
}

if (/participate\.js\?v=hardfork1/.test(partPug) && /admin\.js\?v=hardfork1/.test(adminPug)) {
  pass('Edited scripts cache-bust hardfork1');
} else {
  fail('Edited scripts cache-bust hardfork1', 'stale ?v=');
}

const src = fs.readFileSync(path.join(ROOT, 'public/javascripts/lab/chainDisplay.js'), 'utf8');
const ctx = { window: {}, console, document: undefined };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const FR = ctx.window.ForkRoster;
if (!FR) {
  fail('ForkRoster loaded for split check');
} else {
  const pending = { height: 20, name: 'Big Block Fork' };
  const parts = [
    { userId: 'hub', name: 'Admin', role: 'admin' },
    { userId: 'w1', name: 'Wallet1', role: 'wallet' },
    { userId: 'm1', name: 'MinerA', role: 'miner', forkChoice: 'classic' },
    { userId: 'm2', name: 'MinerB', role: 'miner', forkChoice: 'new' },
    { userId: 'm3', name: 'MinerC', role: 'miner' }
  ];
  const html = FR.renderHtml({
    participants: parts,
    pendingFork: pending,
    selfId: 'hub',
    viewRole: 'admin'
  });
  const classicOk = /Classic[\s\S]*MinerA/.test(html);
  const newOk = /Big Block Fork[\s\S]*MinerB/.test(html);
  const undecidedOk = /Haven’t chosen yet[\s\S]*MinerC/.test(html);
  if (FR.hardForkBucket(parts[2]) === 'classic' &&
      FR.hardForkBucket(parts[3]) === 'new' &&
      FR.hardForkBucket(parts[4]) === 'undecided' &&
      classicOk && newOk && undecidedOk) {
    pass('Roster can list Classic and the new fork at the same time');
  } else {
    fail('Roster can list Classic and the new fork at the same time', html.slice(0, 280));
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log('\n==== hardfork-choice-test: ' + (results.length - failed) + '/' + results.length + ' passed ====');
process.exit(failed ? 1 : 0);
