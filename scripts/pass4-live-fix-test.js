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

// --- 3. Paced way-too-fast retargets may add one leading zero each, never 1→4 ---
(function () {
  const lab = new Relay('DIFFSTEP');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: 1,
    difficultySecondary: 3
  });
  let maxLead = 0;
  let lastL = 1;
  for (let i = 0; i < 12; i++) {
    lab.networkStats.blockIntervals = [300, 300, 300];
    lab.networkStats.totalHashrate = 18000;
    if (lab.networkStats.lastRetarget) lab.networkStats.lastRetarget.at = Date.now() - 20000;
    const beforeL = lab.settings.difficultyLeading;
    const s = lab.maybeRetargetDifficulty();
    if (!s) continue;
    maxLead = Math.max(maxLead, s.difficultyLeading - beforeL);
    lastL = s.difficultyLeading;
  }
  if (maxLead <= 1 && lastL >= 2 && lastL <= 5) {
    pass('12 paced retargets climb zeros without a 1→4 leap',
      'maxLead=' + maxLead + ' lastL=' + lastL);
  } else {
    fail('12 paced retargets climb zeros without a 1→4 leap',
      'maxLead=' + maxLead + ' lastL=' + lastL);
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
  // QT0G4E: leftover 2.1s samples at 5+0xC must not block a 50s tip freeze
  // while miners are still hashing. Ease must move toward easier work.
  if (eased && (
    eased.difficultyLeading < 4 ||
    Number(eased.difficultySecondary) > 1
  )) {
    pass('Frozen tip eases even with leftover fast samples',
      eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
  } else {
    fail('Frozen tip eases even with leftover fast samples',
      eased ? (eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16)) : 'no ease');
  }
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

// --- 6b. GHPEHS Miner 2: 7×10+5 → 2×10, single include, then reorg ---
(function () {
  const lab = new Relay('GHPEHS M2');
  lab.ensureGenesis();
  lab.updateSettings({ difficultyLeading: 1, difficultySecondary: 15, autoDifficulty: false });
  lab.addOrUpdateParticipant('wallet-1', 'wallet', { endowment: 100, balance: 100, displayName: 'Wallet 1' });
  lab.addOrUpdateParticipant('user_x64uho1mu', 'miner', { displayName: 'Miner 2' });
  lab.addOrUpdateParticipant('user_vtxh3dg6e', 'miner', { displayName: 'Miner 3' });
  lab.addOrUpdateParticipant('miner-1', 'miner', { displayName: 'Miner 1' });

  const genesis = lab.chain[0];
  const tx = {
    id: 'tx-ghpehs-5',
    from: 'wallet-1',
    to: 'user_x64uho1mu',
    amount: 5,
    timestamp: 500031
  };
  lab.tryAddTransaction(tx);

  // Shared prefix: Miner 2 has 2 blocks (the post-reorg remainder).
  const s1 = makeBlock(1, '0000m21', genesis.hash, { miner: 'user_x64uho1mu' });
  const s2 = makeBlock(2, '0000m22', s1.hash, { miner: 'user_x64uho1mu' });
  const p1 = lab.tryAddBlock(s1, 'user_x64uho1mu');
  const p2 = lab.tryAddBlock(s2, 'user_x64uho1mu');
  if (!p1.accepted || !p2.accepted) {
    fail('GHPEHS shared prefix accepted', (p1.reason || p2.reason || 'prefix'));
    return;
  }

  // Grow both forks in parallel so stale-parent (>4 back) does not reject.
  // Losing side: Miner 2 mines #3–#5, Miner 3 includes the 5-coin tx at #6
  // (55 = 5×10+5), Miner 2 mines #7–#8 (75 = 7×10+5). Never a second +5.
  let losePrev = s2.hash;
  let winPrev = s2.hash;
  for (let i = 3; i <= 5; i++) {
    const lose = makeBlock(i, '0000l' + i, losePrev, { miner: 'user_x64uho1mu' });
    const win = makeBlock(i, '0000w' + i, winPrev, { miner: 'miner-1' });
    const rl = lab.tryAddBlock(lose, 'user_x64uho1mu');
    const rw = lab.tryAddBlock(win, 'miner-1');
    if (!rl.accepted || !rw.accepted) {
      fail('GHPEHS parallel race stored', (rl.reason || rw.reason || ''));
      return;
    }
    losePrev = lose.hash;
    winPrev = win.hash;
  }

  const include = makeBlock(6, '0000l6tx', losePrev, {
    miner: 'user_vtxh3dg6e',
    transactions: [tx]
  });
  const rInc = lab.tryAddBlock(include, 'user_vtxh3dg6e');
  const m2at5 = lab.participants.get('user_x64uho1mu');
  const wAt5 = lab.participants.get('wallet-1');
  if (!rInc.accepted || !m2at5 || m2at5.blocksMined !== 5 || m2at5.balance !== 55 || !wAt5 || wAt5.balance !== 95) {
    fail('GHPEHS single include: Miner 2 is 55/5 once',
      rInc.accepted
        ? ('m2=' + (m2at5 && m2at5.balance) + '/' + (m2at5 && m2at5.blocksMined) + ' w=' + (wAt5 && wAt5.balance))
        : rInc.reason);
    return;
  }
  if (lab.pendingTransactions.length !== 0) {
    fail('GHPEHS mempool empty after the one include', String(lab.pendingTransactions.length));
    return;
  }
  losePrev = include.hash;

  const win6 = makeBlock(6, '0000w6', winPrev, { miner: 'miner-1' });
  if (!lab.tryAddBlock(win6, 'miner-1').accepted) {
    fail('GHPEHS winning #6 stored', 'rejected');
    return;
  }
  winPrev = win6.hash;

  for (let i = 7; i <= 8; i++) {
    const lose = makeBlock(i, '0000l' + i, losePrev, { miner: 'user_x64uho1mu' });
    const win = makeBlock(i, '0000w' + i, winPrev, { miner: 'miner-1' });
    if (!lab.tryAddBlock(lose, 'user_x64uho1mu').accepted || !lab.tryAddBlock(win, 'miner-1').accepted) {
      fail('GHPEHS continue race to 7 blocks', 'rejected');
      return;
    }
    losePrev = lose.hash;
    winPrev = win.hash;
  }

  const m2at7 = lab.participants.get('user_x64uho1mu');
  if (!(m2at7 && m2at7.blocksMined === 7 && m2at7.balance === 75)) {
    fail('GHPEHS Miner 2 reaches 75/7 (70+5, not 80)',
      m2at7 ? (m2at7.balance + '/' + m2at7.blocksMined) : 'missing');
    return;
  }
  pass('GHPEHS Miner 2 hits 55/5 then 75/7 from one +5', '75/7');

  // One extra empty block on the winning fork — same 5-block unwind as 7→2.
  const win9 = makeBlock(9, '0000w9', winPrev, { miner: 'miner-1' });
  const reorg = lab.tryAddBlock(win9, 'miner-1');
  const m2 = lab.participants.get('user_x64uho1mu');
  const w1 = lab.participants.get('wallet-1');
  const pending = lab.pendingTransactions || [];
  const back = pending.some(function (t) {
    return t && t.from === 'wallet-1' && t.to === 'user_x64uho1mu' && Number(t.amount) === 5;
  });
  const onNewChain = (lab.chain || []).some(function (b) {
    return (b.transactions || []).some(function (t) {
      return t && t.from === 'wallet-1' && Number(t.amount) === 5;
    });
  });
  const anyTxs = (lab.chain || []).some(function (b) {
    return b && b.miner !== 'genesis' && Array.isArray(b.transactions) && b.transactions.length > 0;
  });

  if (reorg.accepted && reorg.reorg && m2 && m2.blocksMined === 2 && m2.balance === 20) {
    pass('GHPEHS reorg drops Miner 2 75/7 → 20/2 (exactly 2×10, +5 gone)',
      m2.balance + '/' + m2.blocksMined);
  } else {
    fail('GHPEHS reorg drops Miner 2 75/7 → 20/2 (exactly 2×10, +5 gone)',
      JSON.stringify({
        accepted: reorg.accepted,
        reorg: reorg.reorg,
        reason: reorg.reason,
        m2: m2 && (m2.balance + '/' + m2.blocksMined)
      }));
  }
  if (w1 && w1.balance === 100 && !onNewChain && back && pending.length === 1) {
    pass('GHPEHS 5-coin tx leaves the replacement chain and re-enters mempool',
      'wallet ' + w1.balance + ', pending ' + pending.length);
  } else {
    fail('GHPEHS 5-coin tx leaves the replacement chain and re-enters mempool',
      'wallet=' + (w1 && w1.balance) + ' onChain=' + onNewChain + ' pending=' + pending.length +
      ' requeued=' + ((reorg.requeuedTransactions || []).length));
  }
  if (!anyTxs) pass('GHPEHS winning main-chain blocks are all Txs 0', '');
  else fail('GHPEHS winning main-chain blocks are all Txs 0', 'a main block still has txs');
  if (m2 && m2.balance !== 25 && m2.balance !== 80) {
    pass('GHPEHS never double-credits the 5-coin send', String(m2.balance));
  } else fail('GHPEHS never double-credits the 5-coin send', String(m2 && m2.balance));
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

// --- 8b. GHPEHS hub late view: 100→95 / 40→45 after reorg+requeue+reinclude ---
(function () {
  const lab = new Relay('GHPEHS HUB');
  lab.ensureGenesis();
  lab.updateSettings({ difficultyLeading: 1, difficultySecondary: 15, autoDifficulty: false });
  lab.addOrUpdateParticipant('user_ixzppaiof', 'wallet', {
    endowment: 100, balance: 100, displayName: 'Wallet 1'
  });
  lab.addOrUpdateParticipant('user_x64uho1mu', 'miner', { displayName: 'Miner 2' });
  lab.addOrUpdateParticipant('miner-1', 'miner', { displayName: 'Miner 1' });
  lab.addOrUpdateParticipant('user_vtxh3dg6e', 'miner', { displayName: 'Miner 3' });

  const genesis = lab.chain[0];
  const tx = {
    id: 'tx-hub-5',
    from: 'user_ixzppaiof',
    to: 'user_x64uho1mu',
    amount: 5,
    timestamp: 500031
  };
  lab.tryAddTransaction(tx);

  const s1 = makeBlock(1, '0000h1', genesis.hash, { miner: 'user_x64uho1mu' });
  const s2 = makeBlock(2, '0000h2', s1.hash, { miner: 'user_x64uho1mu' });
  lab.tryAddBlock(s1, 'user_x64uho1mu');
  lab.tryAddBlock(s2, 'user_x64uho1mu');

  let losePrev = s2.hash;
  let winPrev = s2.hash;
  for (let i = 3; i <= 4; i++) {
    const lose = makeBlock(i, '0000hl' + i, losePrev, { miner: 'user_x64uho1mu' });
    const win = makeBlock(i, '0000hw' + i, winPrev, { miner: 'miner-1' });
    lab.tryAddBlock(lose, 'user_x64uho1mu');
    lab.tryAddBlock(win, 'miner-1');
    losePrev = lose.hash;
    winPrev = win.hash;
  }

  const include = makeBlock(5, '0000hltx', losePrev, {
    miner: 'user_vtxh3dg6e',
    transactions: [tx]
  });
  lab.tryAddBlock(include, 'user_vtxh3dg6e');
  const m2inc = lab.participants.get('user_x64uho1mu');
  const wInc = lab.participants.get('user_ixzppaiof');
  if (!(m2inc && m2inc.blocksMined === 4 && m2inc.balance === 45 && wInc && wInc.balance === 95)) {
    fail('GHPEHS hub first include is 40+5 / 100-5 (not +10 / 90)',
      'm2=' + (m2inc && m2inc.balance) + '/' + (m2inc && m2inc.blocksMined) +
      ' w=' + (wInc && wInc.balance));
    return;
  }
  pass('GHPEHS hub first include is a single debit (95 / 45)', '95/45');

  const win5 = makeBlock(5, '0000hw5', winPrev, { miner: 'miner-1' });
  lab.tryAddBlock(win5, 'miner-1');
  const win6 = makeBlock(6, '0000hw6', win5.hash, { miner: 'miner-1' });
  const reorg = lab.tryAddBlock(win6, 'miner-1');
  const m2re = lab.participants.get('user_x64uho1mu');
  const wRe = lab.participants.get('user_ixzppaiof');
  const pending = lab.pendingTransactions || [];
  const back = pending.some(function (t) {
    return t && t.from === 'user_ixzppaiof' && t.to === 'user_x64uho1mu' && Number(t.amount) === 5;
  });
  if (reorg.reorg && m2re && m2re.balance === 20 && wRe && wRe.balance === 100 && back) {
    pass('GHPEHS hub reorg shows 100 / 20 and the 5-coin tx is pending on the hub',
      pending.length + ' pending');
  } else {
    fail('GHPEHS hub reorg shows 100 / 20 and the 5-coin tx is pending on the hub',
      JSON.stringify({
        reorg: reorg.reorg,
        m2: m2re && m2re.balance,
        w: wRe && wRe.balance,
        pending: pending.length
      }));
    return;
  }

  const w7 = makeBlock(7, '0000hw7', win6.hash, { miner: 'user_x64uho1mu' });
  const w8 = makeBlock(8, '0000hw8', w7.hash, { miner: 'user_x64uho1mu' });
  lab.tryAddBlock(w7, 'user_x64uho1mu');
  lab.tryAddBlock(w8, 'user_x64uho1mu');
  const m2pre = lab.participants.get('user_x64uho1mu');
  if (!(m2pre && m2pre.blocksMined === 4 && m2pre.balance === 40)) {
    fail('GHPEHS hub Miner 2 is 40 before re-include',
      m2pre ? (m2pre.balance + '/' + m2pre.blocksMined) : 'missing');
    return;
  }

  const again = makeBlock(9, '0000hre', w8.hash, {
    miner: 'user_vtxh3dg6e',
    transactions: [lab.pendingTransactions[0]]
  });
  const r2 = lab.tryAddBlock(again, 'user_vtxh3dg6e');
  const m2end = lab.participants.get('user_x64uho1mu');
  const wEnd = lab.participants.get('user_ixzppaiof');
  const stillPending = (lab.pendingTransactions || []).length;
  const txBlocks = (lab.chain || []).filter(function (b) {
    return (b.transactions || []).some(function (t) {
      return t && t.from === 'user_ixzppaiof' && Number(t.amount) === 5;
    });
  });
  if (r2.accepted && wEnd && wEnd.balance === 95 && m2end && m2end.balance === 45
      && stillPending === 0 && txBlocks.length === 1) {
    pass('GHPEHS hub settles 100→95 / 40→45 after requeue+reinclude (not 90 / +10)',
      'txs-on-chain=' + txBlocks.length);
  } else {
    fail('GHPEHS hub settles 100→95 / 40→45 after requeue+reinclude (not 90 / +10)',
      JSON.stringify({
        accepted: r2.accepted,
        w: wEnd && wEnd.balance,
        m2: m2end && m2end.balance,
        pending: stillPending,
        txBlocks: txBlocks.length
      }));
  }
})();

// --- 9. Source / cache-bust / toast placement / attack buttons ---
(function () {
  const theme = fs.readFileSync(path.join(__dirname, '..', 'public/stylesheets/lab-theme.css'), 'utf8');
  const part = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/lab/participate.js'), 'utf8');
  const obs = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/lab/observe.js'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/lab/admin.js'), 'utf8');
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

  const attackFn = admin.match(/function handleTeamAttackClick\([\s\S]*?\n\}/);
  const forkFn = admin.match(/function handleHardForkClick\([\s\S]*?\n\}/);
  const attackBody = attackFn ? attackFn[0] : '';
  const forkBody = forkFn ? forkFn[0] : '';
  const attackWhyBeforeConfirm = /teamCollusionPreconditionError[\s\S]*if\s*\(\s*why\s*\)[\s\S]*return;[\s\S]*confirm\s*\(/.test(attackBody);
  const forkConfirmOnPass = /confirm\s*\(\s*'Propose/.test(forkBody)
    && /hardForkPreconditionError[\s\S]*if\s*\(\s*why\s*\)[\s\S]*return;[\s\S]*confirm\s*\(/.test(forkBody);
  if (attackWhyBeforeConfirm && !/Click Initiate Team Collusion again/.test(admin)) {
    pass('51% checks preconditions before any confirm (no two-click arm)', '');
  } else fail('51% checks preconditions before any confirm (no two-click arm)',
    'whyBeforeConfirm=' + attackWhyBeforeConfirm);
  if (forkConfirmOnPass && !/Click Propose Hard Fork again/.test(admin)) {
    pass('Hard Fork keeps a browser confirm after preconditions pass', '');
  } else fail('Hard Fork keeps a browser confirm after preconditions pass',
    'confirmOnPass=' + forkConfirmOnPass);

  if (/teamCollusionPreconditionError/.test(admin) && /showAttackPanelFeedback/.test(admin)
      && /hardForkPreconditionError/.test(admin) && /showForkPanelFeedback/.test(admin)
      && /scrollIntoView/.test(admin)) {
    pass('Failed 51%/fork preconditions show an in-app panel (not a no-op)', '');
  } else fail('Failed 51%/fork preconditions show an in-app panel (not a no-op)', 'missing');

  const changedStillStale =
    /RelayBlockchainState\.js\?v=p2fix[46]/.test(partPug + obsPug + adminPug) ||
    /participate\.js\?v=p2fix/.test(partPug) ||
    /observe\.js\?v=p2fix/.test(obsPug) ||
    /admin\.js\?v=p2fix/.test(adminPug) ||
    /lab-theme\.css\?v=p2fix/.test(partPug + obsPug + adminPug);
  if (!changedStillStale
      && /RelayBlockchainState\.js\?v=p4fix7/.test(partPug)
      && /participate\.js\?v=p4fix3/.test(partPug)
      && /observe\.js\?v=p4fix5/.test(obsPug)
      && /admin\.js\?v=p4fix7/.test(adminPug)) {
    pass('Changed assets cache-bust (p4fix7 on edited scripts)', '');
  } else fail('Changed assets cache-bust (p4fix7 on edited scripts)', 'stale ?v=');
})();

// --- 10. 2+ miners listed, hashing/hashrate gate fails → in-app reason, no confirm ---
(function () {
  function extractFunction(src, name) {
    const start = src.search(new RegExp('function\\s+' + name + '\\s*\\('));
    if (start < 0) throw new Error('missing ' + name);
    let i = src.indexOf('{', start);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    throw new Error('unbalanced ' + name);
  }

  const adminSrc = fs.readFileSync(
    path.join(__dirname, '..', 'public/javascripts/lab/admin.js'),
    'utf8'
  );
  const Relay = loadRelay();

  function runAttackClick(miners) {
    const parts = new Map();
    miners.forEach(function (p) { parts.set(p.userId, p); });
    const log = { panel: null, toast: null, confirm: 0, started: false };
    const ctx = {
      net: {},
      relayState: { chain: [{ index: 0, hash: 'g' }], participants: parts },
      window: { RelayBlockchainState: Relay },
      RelayBlockchainState: Relay,
      confirm: function () { log.confirm += 1; return true; },
      showAttackPanelFeedback: function (msg) { log.panel = msg; },
      showToastNotification: function (msg) { log.toast = msg; },
      startTeamCollusionAttack: function () { log.started = true; },
      $: function () {
        return { val: function () { return '2'; } };
      }
    };
    vm.createContext(ctx);
    vm.runInContext(
      extractFunction(adminSrc, 'listLiveMinerIds') + '\n' +
      extractFunction(adminSrc, 'teamCollusionPreconditionError') + '\n' +
      extractFunction(adminSrc, 'handleTeamAttackClick') + '\n' +
      'handleTeamAttackClick();',
      ctx
    );
    return log;
  }

  const idle = runAttackClick([
    { userId: 'miner-a', role: 'miner', hashrate: 0 },
    { userId: 'miner-b', role: 'miner', hashrate: 0 },
    { userId: 'wallet-1', role: 'wallet', hashrate: 0, endowment: 100 }
  ]);
  if (idle.confirm === 0 && !idle.started && /hashing/i.test(idle.panel || '') && idle.toast === idle.panel) {
    pass('2 miners listed but idle: 51% shows in-app hashing reason (no confirm)', idle.panel);
  } else {
    fail('2 miners listed but idle: 51% shows in-app hashing reason (no confirm)',
      JSON.stringify(idle));
  }

  const weakShare = runAttackClick([
    { userId: 'miner-a', role: 'miner', hashrate: 10000 },
    { userId: 'miner-b', role: 'miner', hashrate: 10000 },
    { userId: 'miner-c', role: 'miner', hashrate: 10000 },
    { userId: 'miner-d', role: 'miner', hashrate: 10000 }
  ]);
  // 4 equal miners: stronger half is 50% — blocked, not a confirm that would run
  if (weakShare.confirm === 0 && !weakShare.started && /50%|more than 50%/i.test(weakShare.panel || '')) {
    pass('2+ miners hashing but stronger half is not >50%: in-app reason, no confirm',
      weakShare.panel);
  } else {
    fail('2+ miners hashing but stronger half is not >50%: in-app reason, no confirm',
      JSON.stringify(weakShare));
  }

  const ready = runAttackClick([
    { userId: 'miner-a', role: 'miner', hashrate: 20000 },
    { userId: 'miner-b', role: 'miner', hashrate: 20000 },
    { userId: 'miner-c', role: 'miner', hashrate: 20000 }
  ]);
  if (ready.confirm === 1 && ready.started && !ready.panel) {
    pass('51% opens confirm only after hashrate preconditions pass', '');
  } else {
    fail('51% opens confirm only after hashrate preconditions pass', JSON.stringify(ready));
  }
})();

const failed = results.filter((r) => !r.ok).length;
console.log('\n==== pass4-live-fix-test: ' + (results.length - failed) + '/' + results.length + ' passed ====');
process.exit(failed ? 1 : 0);
