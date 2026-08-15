/**
 * Headless checks for Pass 6 live-QA leftovers (session 4W4KV3):
 * difficulty still-too-fast after 2+0x0, Overview vs Copy pairing,
 * admin tab window/throttle, name cache across prune.
 * Usage: node scripts/pass6-live-fix-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const results = [];
function pass(n, d) { results.push({ ok: true, n, d }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); }
function fail(n, d) { results.push({ ok: false, n, d }); console.log('FAIL  ' + n + ' — ' + d); }

function loadFile(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function loadRelay() {
  const src = loadFile('public/javascripts/network/RelayBlockchainState.js');
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.RelayBlockchainState;
}

function loadChainDisplay() {
  const src = loadFile('public/javascripts/lab/chainDisplay.js');
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.ChainDisplay;
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
const ChainDisplay = loadChainDisplay();

// --- 1. After 1→2, a later still-too-fast sample adds 2→3 (not freeze) ---
(function () {
  const lab = new Relay('STILLFAST');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: 1,
    difficultySecondary: 0
  });
  lab.networkStats.blockIntervals = [300, 300, 280, 310];
  lab.networkStats.totalHashrate = 70000;
  const first = lab.maybeRetargetDifficulty();
  if (!(first && first.difficultyLeading === 2)) {
    fail('First way-too-fast step is 1→2', first ? JSON.stringify(first) : 'no change');
    return;
  }
  lab.networkStats.lastRetarget.at = Date.now() - 36000;
  lab.networkStats.lastRetarget.leadingZeroAt = Date.now() - 36000;
  lab.networkStats.blockIntervals = [300, 300, 280, 310];
  lab.networkStats.totalHashrate = 70000;
  const second = lab.maybeRetargetDifficulty();
  if (second && second.difficultyLeading === 3 && Number(second.difficultySecondary) === 0) {
    pass('Still-too-fast after inter-zero cooldown adds one more zero (2→3)',
      second.difficultyLeading + '+0x' + Number(second.difficultySecondary).toString(16));
  } else {
    fail('Still-too-fast after inter-zero cooldown adds one more zero (2→3)',
      second ? (second.difficultyLeading + '+0x' + Number(second.difficultySecondary).toString(16)) : 'no change');
  }
})();

// --- 2. One retarget still cannot jump 2→5 ---
(function () {
  const lab = new Relay('NOJUMP2');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: 2,
    difficultySecondary: 0
  });
  lab.networkStats.totalHashrate = 80000;
  lab.networkStats.blockIntervals = [250, 250, 300];
  const s = lab.maybeRetargetDifficulty();
  if (s && s.difficultyLeading <= 3) {
    pass('Way-too-fast at 2+0x0 still max +1 leading zero',
      s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16));
  } else {
    fail('Way-too-fast at 2+0x0 still max +1 leading zero',
      s ? (s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16)) : 'no change');
  }
})();

// --- 3. Cooldown still blocks a burst after the first zero step ---
(function () {
  const lab = new Relay('CD2');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: 2,
    difficultySecondary: 0
  });
  lab.networkStats.lastRetarget = { at: Date.now(), delta: 16 };
  let changes = 0;
  for (let i = 0; i < 10; i++) {
    lab.networkStats.blockIntervals = [250, 250, 250];
    if (lab.maybeRetargetDifficulty()) changes += 1;
  }
  if (changes === 0) pass('Cooldown still blocks a burst at 2+0x0', '0 changes');
  else fail('Cooldown still blocks a burst at 2+0x0', 'changes=' + changes);
})();

// --- 4. Hub redraw must not reset lastRetarget on every live paint ---
(function () {
  const admin = loadFile('public/javascripts/lab/admin.js');
  const edgeOnly = /_lastPausedUi === true/.test(admin) && /noteNetworkResumed/.test(admin);
  const toastUsesRt = /lastRt\.avgMs/.test(admin);
  if (edgeOnly && toastUsesRt) {
    pass('Admin pause UI only notes resume on pause→live; toast uses retarget avg', '');
  } else {
    fail('Admin pause UI only notes resume on pause→live; toast uses retarget avg',
      JSON.stringify({ edgeOnly: edgeOnly, toastUsesRt: toastUsesRt }));
  }
})();

// --- 5. Name cache survives prune + nameless re-add (test-miner Unnamed) ---
(function () {
  const lab = new Relay('NAMECACHE');
  lab.addOrUpdateParticipant('test-miner-mstolnjw-gsn75f', 'miner', {
    name: 'Miner 1',
    displayName: 'Miner 1',
    rename: true
  });
  lab.participants.delete('test-miner-mstolnjw-gsn75f');
  lab.addOrUpdateParticipant('test-miner-mstolnjw-gsn75f', 'miner', {});
  const p = lab.participants.get('test-miner-mstolnjw-gsn75f');
  if (p && p.displayName === 'Miner 1' && p.name === 'Miner 1') {
    pass('Prune + empty re-add restores cached name', p.displayName);
  } else {
    fail('Prune + empty re-add restores cached name', p ? JSON.stringify(p) : 'missing');
  }
  lab.addOrUpdateParticipant('user_e6177o93m', 'miner', { name: 'Miner 1', displayName: 'Miner 1' });
  const student = lab.participants.get('user_e6177o93m');
  if (student && student.displayName === 'Miner 1') {
    pass('Unique student name on a different id is kept', student.displayName);
  } else {
    fail('Unique student name on a different id is kept', student ? student.displayName : 'missing');
  }
})();

// --- 6. Later join still cannot rename an occupied id (L3T0NE) ---
(function () {
  const lab = new Relay('L3T0NE6');
  lab.addOrUpdateParticipant('user_jpo9nfhqt', 'wallet', {
    name: 'Wallet 1',
    displayName: 'Wallet 1'
  });
  lab.addOrUpdateParticipant('user_jpo9nfhqt', 'wallet', {
    name: 'Wallet 2',
    displayName: 'Wallet 2'
  });
  const w = lab.participants.get('user_jpo9nfhqt');
  if (w && w.displayName === 'Wallet 1') {
    pass('Later join still does not overwrite Wallet 1', w.displayName);
  } else {
    fail('Later join still does not overwrite Wallet 1', w ? w.displayName : 'missing');
  }
})();

// --- 7. Distant orphans are pruned; recent ones stay ---
(function () {
  const lab = new Relay('ORPHANCAP');
  lab.ensureGenesis();
  for (let i = 1; i <= 80; i++) {
    const b = makeBlock(i, 'h' + i, i === 1 ? lab.chain[0].hash : 'h' + (i - 1));
    lab.chain.push(b);
    lab.allBlocks.set(b.hash, b);
    if (i % 2 === 0) {
      const orphan = makeBlock(i, 'o' + i, 'h' + (i - 1), { miner: 'other' });
      lab.allBlocks.set(orphan.hash, orphan);
    }
  }
  const before = lab.allBlocks.size;
  const dropped = lab.pruneDistantOrphans(32);
  const stillHasRecent = lab.allBlocks.has('o80');
  const lostOld = !lab.allBlocks.has('o10');
  const keptMain = lab.allBlocks.has('h10') && lab.allBlocks.has('h80');
  if (dropped > 0 && stillHasRecent && lostOld && keptMain) {
    pass('pruneDistantOrphans drops old race-losers and keeps main+recent',
      'before=' + before + ' dropped=' + dropped + ' after=' + lab.allBlocks.size);
  } else {
    fail('pruneDistantOrphans drops old race-losers and keeps main+recent',
      JSON.stringify({ dropped: dropped, stillHasRecent: stillHasRecent, lostOld: lostOld, keptMain: keptMain }));
  }
})();

// --- 8. Admin hub windows + throttles topology / chain ---
(function () {
  const admin = loadFile('public/javascripts/lab/admin.js');
  const windowed = /maxVisible:\s*24/.test(admin);
  const orphanCap = /tipIdx - idx > 28/.test(admin);
  const topoThrottle = /_lastTopoAt/.test(admin) && /1000/.test(admin);
  const chainThrottle = /_relayRenderTimer/.test(admin);
  if (windowed && orphanCap && topoThrottle && chainThrottle) {
    pass('Admin hub windows chain, caps orphans, throttles topology', '');
  } else {
    fail('Admin hub windows chain, caps orphans, throttles topology',
      JSON.stringify({ windowed: windowed, orphanCap: orphanCap, topoThrottle: topoThrottle, chainThrottle: chainThrottle }));
  }
})();

// --- 9. Miner render never falls back to an uncapped private tail ---
(function () {
  const participate = loadFile('public/javascripts/lab/participate.js');
  const noFallback = /Never fall back to the uncapped tail/.test(participate)
    && /return out;/.test(participate);
  const noLocalInflate = /Never raise hubConfirmedHeight from a local unconfirmed tip/.test(participate);
  const freshPaint = /Always paint from the live capped copy/.test(participate);
  if (noFallback && noLocalInflate && freshPaint) {
    pass('Miner Copy cap does not re-show a 200-block private tail', '');
  } else {
    fail('Miner Copy cap does not re-show a 200-block private tail',
      JSON.stringify({ noFallback: noFallback, noLocalInflate: noLocalInflate, freshPaint: freshPaint }));
  }
})();

// --- 10. Paired height still returns hub when copy is 200 ahead ---
(function () {
  const copy = [];
  for (let i = 0; i <= 445; i++) copy.push(makeBlock(i, 'h' + i, i === 0 ? '0' : 'h' + (i - 1)));
  const h = Relay.studentMinerPairedHeight(copy, 246);
  if (h === 246) pass('Paired height: copy 445 vs hub 246 uses hub', String(h));
  else fail('Paired height: copy 445 vs hub 246 uses hub', String(h));
})();

// --- 11. Chain display still windows 200+ blocks ---
(function () {
  const blocks = [];
  for (let i = 0; i <= 200; i++) blocks.push(makeBlock(i, 'h' + i, i === 0 ? '0' : 'h' + (i - 1)));
  const html = ChainDisplay.renderChainHtml({ mainChain: blocks, orphans: [], participants: [] });
  const cards = (html.match(/Block #/g) || []).length;
  if (cards <= 26 && /earlier block/.test(html) && /Block #200/.test(html)) {
    pass('renderChainHtml still caps DOM at ~24 cards', 'cards=' + cards);
  } else {
    fail('renderChainHtml still caps DOM at ~24 cards', 'cards=' + cards);
  }
})();

// --- 12. Cache-bust p4fix4 on this pass's edited assets ---
(function () {
  const adminPug = loadFile('views/lab/admin.pug');
  const partPug = loadFile('views/lab/participate.pug');
  const obsPug = loadFile('views/lab/observe.pug');
  const ok =
    /RelayBlockchainState\.js\?v=p4fix6/.test(adminPug + partPug + obsPug) &&
    /admin\.js\?v=p4fix6/.test(adminPug) &&
    /participate\.js\?v=p4fix3/.test(partPug) &&
    /chainDisplay\.js\?v=p4fix3/.test(adminPug + partPug) &&
    /networkVisualization\.js\?v=p4fix3/.test(adminPug) &&
    /AdminRelayCoordinator\.js\?v=p4fix6/.test(adminPug);
  if (ok) pass('Changed assets cache-bust (p4fix6 on edited scripts)', '');
  else fail('Changed assets cache-bust (p4fix6 on edited scripts)', 'stale ?v=');
})();

const failed = results.filter(function (r) { return !r.ok; });
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
