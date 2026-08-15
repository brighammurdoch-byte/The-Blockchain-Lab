/**
 * Headless checks for classroom consensus fixes (items 5–6, 12).
 * Usage: node scripts/consensus-unit-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadRelay() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public/javascripts/network/RelayBlockchainState.js'),
    'utf8'
  );
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.RelayBlockchainState;
}

function loadEth() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public/javascripts/chains/ethereumRules.js'),
    'utf8'
  );
  const ctx = {
    window: {},
    console,
    CryptoJS: { SHA256: (t) => ({ toString: () => 'hash-' + String(t).length }) }
  };
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.EthereumLab || ctx.window.EthereumLab;
}

const results = [];
function pass(n, d) { results.push({ ok: true, n, d }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); }
function fail(n, d) { results.push({ ok: false, n, d }); console.log('FAIL  ' + n + ' — ' + d); }

const Relay = loadRelay();
const Eth = loadEth();

// --- 5. Double-include ---
(function () {
  const lab = new Relay('UNIT');
  lab.ensureGenesis();
  lab.updateSettings({ difficultyLeading: 1, difficultySecondary: 15, autoDifficulty: false });

  const tx = { id: 'tx-1', from: 'wallet-a', to: 'miner-b', amount: 5, timestamp: 1000 };
  const genesis = lab.chain[0];
  const block1 = {
    index: 1,
    hash: '0abc',
    previousHash: genesis.hash,
    timestamp: Date.now(),
    nonce: 1,
    transactions: [tx],
    miner: 'miner-3'
  };
  const r1 = lab.tryAddBlock(block1, 'miner-3');
  if (!r1.accepted) {
    fail('First include accepted', r1.reason);
    return;
  }
  pass('First include accepted', 'height ' + r1.newHeight);

  const block2 = {
    index: 2,
    hash: '0def',
    previousHash: block1.hash,
    timestamp: Date.now() + 10,
    nonce: 2,
    transactions: [{ from: 'wallet-a', to: 'miner-b', amount: 5, timestamp: 1000 }],
    miner: 'miner-2'
  };
  const r2 = lab.tryAddBlock(block2, 'miner-2');
  if (r2.accepted) fail('Second include rejected (same content, no id)', 'accepted');
  else pass('Second include rejected (same content, no id)', r2.reason);

  const pending = lab.tryAddTransaction(tx);
  if (pending.accepted && !pending.duplicate) fail('Confirmed tx stays out of mempool', 're-accepted');
  else pass('Confirmed tx stays out of mempool', pending.reason || 'duplicate');

  const wallet = lab.participants.get('wallet-a');
  // endowment 100 for wallet role created by recompute
  if (wallet && wallet.balance === 95) pass('Sender debited once', String(wallet.balance));
  else fail('Sender debited once', wallet ? String(wallet.balance) : 'missing wallet');
})();

// --- 6. Difficulty damping ---
(function () {
  const lab = new Relay('DIFF');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: 1,
    difficultySecondary: 2
  });
  lab.networkStats.totalHashrate = 80000;
  lab.networkStats.blockIntervals = [300, 300, 300, 300];
  const s1 = lab.maybeRetargetDifficulty();
  if (!s1) {
    fail('Retarget moves when blocks are 0.3s', 'no change');
    return;
  }
  const score1 = lab._difficultyScore(s1.difficultyLeading, s1.difficultySecondary);
  const start = 1 * 16 + 2;
  const jump = score1 - start;
  if (jump > 0 && jump <= 2) pass('First retarget is damped (≤2 steps)', 'delta ' + jump + ' → ' + s1.difficultyLeading + '+0x' + s1.difficultySecondary.toString(16));
  else fail('First retarget is damped (≤2 steps)', 'delta ' + jump);

  // Climb many times with still-fast intervals; must not leap a leading zero
  let maxStep = jump;
  let maxLeadJump = 0;
  for (let i = 0; i < 20; i++) {
    lab.networkStats.blockIntervals = [400, 400, 400];
    lab.networkStats.totalHashrate = 80000;
    if (lab.networkStats.lastRetarget) lab.networkStats.lastRetarget.at = Date.now() - 10000;
    const beforeL = lab.settings.difficultyLeading;
    const before = lab._difficultyScore(lab.settings.difficultyLeading, lab.settings.difficultySecondary);
    const s = lab.maybeRetargetDifficulty();
    if (!s) continue;
    const after = lab._difficultyScore(s.difficultyLeading, s.difficultySecondary);
    maxStep = Math.max(maxStep, after - before);
    maxLeadJump = Math.max(maxLeadJump, s.difficultyLeading - beforeL);
  }
  if (maxStep <= 2) pass('No retarget jumps more than 2 ladder steps', 'max step ' + maxStep);
  else fail('No retarget jumps more than 2 ladder steps', 'max step ' + maxStep);
  if (maxLeadJump <= 1) pass('No retarget adds more than 1 leading zero', 'max lead +' + maxLeadJump);
  else fail('No retarget adds more than 1 leading zero', 'max lead +' + maxLeadJump);

  const want = lab._scoreForTargetHashes(80000 * 10);
  const wantDiff = lab._scoreToDifficulty(want);
  pass('80kH/s @ 10s implies ~' + wantDiff.difficultyLeading + '+0x' + wantDiff.difficultySecondary.toString(16),
    'expected hashes ' + Math.round(lab._expectedHashes(wantDiff.difficultyLeading, wantDiff.difficultySecondary)));

  // Stall ease must not collapse to 1+0 in one tick
  lab.updateSettings({ difficultyLeading: 5, difficultySecondary: 0, autoDifficulty: true, targetBlockTimeSec: 10 });
  lab.networkStats.totalHashrate = 80000;
  lab.networkStats.lastBlockTime = Date.now() - 60000;
  const eased = lab.maybeEaseDifficultyIfStalled();
  if (!eased) {
    pass('Stall ease respects hashrate floor (no collapse)', 'no drop below floor');
  } else if (eased.difficultyLeading >= 4) {
    pass('Stall ease steps down gently', eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
  } else {
    fail('Stall ease steps down gently', eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
  }
})();

// --- 12. 0xPeer rejected ---
(function () {
  if (!Eth || !Eth.Chain) {
    fail('Ethereum rules loaded', 'missing EthereumLab');
    return;
  }
  const chain = new Eth.Chain();
  chain._acct('0xStudent').balance = 5 * Eth.WEI;
  const bad = chain.addTransaction('0xStudent', '0xPeer', 1);
  if (!bad.ok) pass('0xPeer rejected from mempool', bad.error);
  else fail('0xPeer rejected from mempool', 'accepted');

  const empty = chain.addTransaction('0xStudent', '', 1);
  if (!empty.ok) pass('Empty address rejected', empty.error);
  else fail('Empty address rejected', 'accepted');

  const ok = chain.addTransaction('0xStudent', '0xTreasury', 1);
  if (ok.ok) pass('Valid 0xTreasury accepted', '');
  else fail('Valid 0xTreasury accepted', ok.error);
})();

const failed = results.filter((r) => !r.ok).length;
console.log('\n==== consensus-unit-test: ' + (results.length - failed) + '/' + results.length + ' passed ====');
process.exit(failed ? 1 : 0);
