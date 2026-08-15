/**
 * Headless checks for Pass 4 live-QA leftovers:
 * auto-difficulty overshoot, reorg mempool requeue, phone toast vs hamburger.
 * Usage: node scripts/pass4-live-fix-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const results = [];
function pass(n, d) { results.push({ ok: true, n, d }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); }
function fail(n, d) { results.push({ ok: false, n, d }); console.log('FAIL  ' + n + ' — ' + d); }

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

function makeBlock(index, hash, prev, extra) {
  return Object.assign({
    index: index,
    hash: hash,
    previousHash: prev || (index === 0 ? '0' : 'h' + (index - 1)),
    miner: index === 0 ? 'genesis' : 'miner-1',
    timestamp: 1000 + index * 1000,
    nonce: index,
    transactions: []
  }, extra || {});
}

const Relay = loadRelay();

// --- 1. One retarget cannot jump 1 leading zero → 4 zeros ---
(function () {
  const lab = new Relay('DIFFJUMP');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: 1,
    difficultySecondary: 3
  });
  lab.networkStats.totalHashrate = 18000;
  lab.networkStats.blockIntervals = [250, 250, 300, 280];
  const s = lab.maybeRetargetDifficulty();
  if (!s) {
    fail('3-miner burst still retargets', 'no change');
    return;
  }
  if (s.difficultyLeading <= 2) {
    pass('3-miner 18kH/s does not snap 1→4 zeros',
      s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16));
  } else {
    fail('3-miner 18kH/s does not snap 1→4 zeros',
      s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16));
  }
})();

// --- 2. Cooldown: a burst of tip extensions cannot climb 3 zeros instantly ---
(function () {
  const lab = new Relay('DIFFCD');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: 1,
    difficultySecondary: 3
  });
  lab.networkStats.totalHashrate = 18000;
  let changes = 0;
  let maxL = 1;
  for (let i = 0; i < 15; i++) {
    lab.networkStats.blockIntervals = [250, 250, 250];
    lab.networkStats.totalHashrate = 18000;
    const s = lab.maybeRetargetDifficulty();
    if (s) {
      changes += 1;
      maxL = Math.max(maxL, s.difficultyLeading);
    }
  }
  if (changes <= 1 && maxL <= 2) {
    pass('No cooldown bypass: 15 fast samples → at most one nibble step',
      'changes=' + changes + ' maxL=' + maxL);
  } else {
    fail('No cooldown bypass: 15 fast samples → at most one nibble step',
      'changes=' + changes + ' maxL=' + maxL);
  }
})();

// --- 3. Even with cooldown cleared, each step is ≤2 nibbles and ≤1 zero ---
(function () {
  const lab = new Relay('DIFFSTEP');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: 1,
    difficultySecondary: 3
  });
  let maxStep = 0;
  let maxLead = 0;
  let lastL = 1;
  for (let i = 0; i < 12; i++) {
    lab.networkStats.blockIntervals = [300, 300, 300];
    lab.networkStats.totalHashrate = 18000;
    if (lab.networkStats.lastRetarget) lab.networkStats.lastRetarget.at = Date.now() - 20000;
    const before = lab._difficultyScore(lab.settings.difficultyLeading, lab.settings.difficultySecondary);
    const beforeL = lab.settings.difficultyLeading;
    const s = lab.maybeRetargetDifficulty();
    if (!s) continue;
    const after = lab._difficultyScore(s.difficultyLeading, s.difficultySecondary);
    maxStep = Math.max(maxStep, after - before);
    maxLead = Math.max(maxLead, s.difficultyLeading - beforeL);
    lastL = s.difficultyLeading;
  }
  if (maxStep <= 2 && maxLead <= 1 && lastL < 4) {
    pass('12 paced retargets stay bounded (no 1→4 leap)',
      'maxStep=' + maxStep + ' maxLead=' + maxLead + ' lastL=' + lastL);
  } else {
    fail('12 paced retargets stay bounded (no 1→4 leap)',
      'maxStep=' + maxStep + ' maxLead=' + maxLead + ' lastL=' + lastL);
  }
})();

// --- 4. After an upward retarget, stall-ease fires (empty post-retarget samples) ---
(function () {
  const lab = new Relay('STALLEASE');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: 4,
    difficultySecondary: 5
  });
  lab.networkStats.totalHashrate = 18000;
  lab.networkStats.blockIntervals = [];
  lab.networkStats.lastBlockTime = Date.now() - 16000;
  lab.networkStats.lastRetarget = {
    at: Date.now() - 16000,
    delta: 2,
    leading: 4,
    secondary: 5
  };
  const eased = lab.maybeEaseDifficultyIfStalled();
  if (eased && eased.difficultyLeading === 4 && Number(eased.difficultySecondary) < 5) {
    pass('Stall-ease after upward retarget walks one nibble',
      eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
  } else if (eased) {
    pass('Stall-ease after upward retarget steps down',
      eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
  } else {
    fail('Stall-ease after upward retarget walks one nibble', 'no ease (25s freeze still present)');
  }
})();

// --- 5. Fast samples at CURRENT difficulty still skip ease ---
(function () {
  const lab = new Relay('STALLFAST');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: 4,
    difficultySecondary: 1
  });
  lab.networkStats.totalHashrate = 80000;
  lab.networkStats.blockIntervals = [250, 250, 250, 250];
  lab.networkStats.averageBlockTimeMs = 250;
  lab.networkStats.lastBlockTime = Date.now() - 50000;
  const eased = lab.maybeEaseDifficultyIfStalled();
  if (!eased) pass('Stall-ease skipped when current-difficulty blocks were too fast', '');
  else fail('Stall-ease skipped when current-difficulty blocks were too fast',
    eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
})();

// --- 6. Reorg puts the orphaned transfer back in the mempool ---
(function () {
  const lab = new Relay('REORG TX');
  lab.ensureGenesis();
  lab.updateSettings({ difficultyLeading: 1, difficultySecondary: 15, autoDifficulty: false });
  lab.addOrUpdateParticipant('wallet-1', 'wallet', { endowment: 100, balance: 100 });
  lab.addOrUpdateParticipant('miner-2', 'miner');
  lab.addOrUpdateParticipant('miner-3', 'miner');

  const genesis = lab.chain[0];
  const tx = { id: 'tx-5', from: 'wallet-1', to: 'miner-2', amount: 5, timestamp: 5000 };
  lab.tryAddTransaction(tx);

  const b1 = makeBlock(1, '0000a1', genesis.hash, { miner: 'miner-3', transactions: [tx] });
  const r1 = lab.tryAddBlock(b1, 'miner-3');
  if (!r1.accepted) {
    fail('Including block accepted', r1.reason);
    return;
  }
  const w1 = lab.participants.get('wallet-1');
  if (!(w1 && w1.balance === 95)) {
    fail('Sender debited while tx is on chain', w1 ? String(w1.balance) : 'missing');
    return;
  }
  if (lab.pendingTransactions.length !== 0) {
    fail('Mempool empty after include', String(lab.pendingTransactions.length));
    return;
  }

  // Longer competing fork from genesis without the tx (2 blocks → reorg)
  const c1 = makeBlock(1, '0000b1', genesis.hash, { miner: 'miner-1', transactions: [] });
  const a1 = lab.tryAddBlock(c1, 'miner-1');
  if (!a1.accepted) {
    fail('Competing #1 stored', a1.reason);
    return;
  }
  const c2 = makeBlock(2, '0000b2', c1.hash, { miner: 'miner-1', transactions: [] });
  const a2 = lab.tryAddBlock(c2, 'miner-1');
  if (!a2.accepted || !a2.reorg) {
    fail('Longer empty fork wins', JSON.stringify({ accepted: a2.accepted, reorg: a2.reorg, reason: a2.reason }));
    return;
  }

  const tip = lab.chain[lab.chain.length - 1];
  const tipTxs = (tip && tip.transactions) || [];
  const pending = lab.pendingTransactions || [];
  const back = pending.some(function (t) {
    return t && (t.id === 'tx-5' || (t.from === 'wallet-1' && t.to === 'miner-2' && Number(t.amount) === 5));
  });
  const wAfter = lab.participants.get('wallet-1');
  const m2 = lab.participants.get('miner-2');

  if (a2.requeuedTransactions && a2.requeuedTransactions.length && back) {
    pass('Orphaned 5-coin tx re-enters mempool', pending.length + ' pending');
  } else {
    fail('Orphaned 5-coin tx re-enters mempool',
      'pending=' + pending.length + ' requeued=' + JSON.stringify(a2.requeuedTransactions));
  }
  if (wAfter && wAfter.balance === 100) pass('Wallet balance matches new canonical chain', String(wAfter.balance));
  else fail('Wallet balance matches new canonical chain', wAfter ? String(wAfter.balance) : 'missing');
  if (m2 && Number(m2.balance) === 0) pass('Miner 2 is not credited for a vanished transfer', String(m2.balance));
  else fail('Miner 2 is not credited for a vanished transfer', m2 ? String(m2.balance) : 'missing');
  if (tip && tip.hash === '0000b2' && tipTxs.length === 0) {
    pass('Replacement tip has Txs 0 (old #1 is not still showing the transfer)', tip.hash);
  } else {
    fail('Replacement tip has Txs 0 (old #1 is not still showing the transfer)',
      tip ? tip.hash + ' txs=' + tipTxs.length : 'no tip');
  }
})();

// --- 7. Tx that is still on the winning fork is not re-queued ---
(function () {
  const lab = new Relay('REORG KEEP');
  lab.ensureGenesis();
  lab.updateSettings({ difficultyLeading: 1, difficultySecondary: 15, autoDifficulty: false });
  lab.addOrUpdateParticipant('wallet-1', 'wallet', { endowment: 100, balance: 100 });
  const genesis = lab.chain[0];
  const tx = { id: 'tx-keep', from: 'wallet-1', to: 'miner-2', amount: 5, timestamp: 5000 };
  const shared = makeBlock(1, '0000s1', genesis.hash, { miner: 'miner-3', transactions: [tx] });
  lab.tryAddBlock(shared, 'miner-3');
  const side = makeBlock(2, '0000s2a', shared.hash, { miner: 'miner-3', transactions: [] });
  lab.tryAddBlock(side, 'miner-3');
  const win1 = makeBlock(2, '0000s2b', shared.hash, { miner: 'miner-1', transactions: [] });
  lab.tryAddBlock(win1, 'miner-1');
  const win2 = makeBlock(3, '0000s3b', win1.hash, { miner: 'miner-1', transactions: [] });
  const r = lab.tryAddBlock(win2, 'miner-1');
  const pending = lab.pendingTransactions || [];
  const resurrected = pending.some(function (t) { return t && t.id === 'tx-keep'; });
  if (r.reorg && !resurrected) pass('Tx still on winning fork stays confirmed', '');
  else fail('Tx still on winning fork stays confirmed',
    'reorg=' + r.reorg + ' pending=' + pending.length);
})();

// --- 8. Unspendable orphaned tx is dropped, not silently lost without a reason ---
(function () {
  const lab = new Relay('REORG DROP');
  lab.ensureGenesis();
  lab.updateSettings({ difficultyLeading: 1, difficultySecondary: 15, autoDifficulty: false });
  lab.addOrUpdateParticipant('broke', 'miner', { endowment: 0, balance: 0 });
  const genesis = lab.chain[0];
  const tx = { id: 'tx-broke', from: 'broke', to: 'miner-2', amount: 5, timestamp: 5000 };
  const b1 = makeBlock(1, '0000d1', genesis.hash, { miner: 'miner-3', transactions: [tx] });
  lab.tryAddBlock(b1, 'miner-3');
  const c1 = makeBlock(1, '0000e1', genesis.hash, { miner: 'miner-1', transactions: [] });
  lab.tryAddBlock(c1, 'miner-1');
  const c2 = makeBlock(2, '0000e2', c1.hash, { miner: 'miner-1', transactions: [] });
  const r = lab.tryAddBlock(c2, 'miner-1');
  const pending = lab.pendingTransactions || [];
  const back = pending.some(function (t) { return t && t.id === 'tx-broke'; });
  if (!back && r.droppedTransactions && r.droppedTransactions.length) {
    pass('Unspendable reorged tx is dropped with a reason', r.droppedTransactions[0].reason);
  } else {
    fail('Unspendable reorged tx is dropped with a reason',
      'pending=' + pending.length + ' dropped=' + JSON.stringify(r.droppedTransactions));
  }
})();

// --- 9. Source / cache-bust / toast placement ---
(function () {
  const theme = fs.readFileSync(path.join(__dirname, '..', 'public/stylesheets/lab-theme.css'), 'utf8');
  const part = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/lab/participate.js'), 'utf8');
  const obs = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/lab/observe.js'), 'utf8');
  const relay = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/network/RelayBlockchainState.js'), 'utf8');
  const partPug = fs.readFileSync(path.join(__dirname, '..', 'views/lab/participate.pug'), 'utf8');
  const obsPug = fs.readFileSync(path.join(__dirname, '..', 'views/lab/observe.pug'), 'utf8');
  const adminPug = fs.readFileSync(path.join(__dirname, '..', 'views/lab/admin.pug'), 'utf8');

  if (/z-index:\s*1100/.test(theme) && /navbar-toggle/.test(theme) && /right:\s*56px/.test(theme)) {
    pass('Theme keeps hamburger above toasts and insets the phone bar', '');
  } else fail('Theme keeps hamburger above toasts and insets the phone bar', 'missing CSS');

  if (/pointer-events:\s*none/.test(theme)) {
    pass('Toasts do not capture taps over the navbar toggle', '');
  } else fail('Toasts do not capture taps over the navbar toggle', 'missing pointer-events');

  if (!/z-index:\s*1030/.test(part) && /lab-toast/.test(part)) {
    pass('participate.js toast no longer uses navbar z-index 1030', '');
  } else fail('participate.js toast no longer uses navbar z-index 1030', 'still 1030 or missing class');

  if (/_requeueOrphanedTransactions/.test(relay) && /requeuedTransactions/.test(relay)) {
    pass('Hub requeues orphaned mempool txs on reorg', '');
  } else fail('Hub requeues orphaned mempool txs on reorg', 'missing helper');

  if (/returned to mempool/.test(obs) && /returned to mempool/.test(part)) {
    pass('Wallet and miner toast when a transfer is re-queued', '');
  } else fail('Wallet and miner toast when a transfer is re-queued', 'missing copy');

  const changedStillStale =
    /RelayBlockchainState\.js\?v=p2fix[46]/.test(partPug + obsPug + adminPug) ||
    /participate\.js\?v=p2fix/.test(partPug) ||
    /observe\.js\?v=p2fix/.test(obsPug) ||
    /admin\.js\?v=p2fix/.test(adminPug) ||
    /lab-theme\.css\?v=p2fix/.test(partPug + obsPug + adminPug);
  if (!changedStillStale
      && /RelayBlockchainState\.js\?v=p3fix1/.test(partPug)
      && /participate\.js\?v=p3fix1/.test(partPug)
      && /observe\.js\?v=p3fix1/.test(obsPug)
      && /admin\.js\?v=p3fix1/.test(adminPug)) {
    pass('Changed assets cache-bust to p3fix1 (no leftover p2fix4/p2fix6 on those files)', '');
  } else fail('Changed assets cache-bust to p3fix1 (no leftover p2fix4/p2fix6 on those files)', 'stale ?v=');
})();

const failed = results.filter((r) => !r.ok).length;
console.log('\n==== pass4-live-fix-test: ' + (results.length - failed) + '/' + results.length + ' passed ====');
process.exit(failed ? 1 : 0);
