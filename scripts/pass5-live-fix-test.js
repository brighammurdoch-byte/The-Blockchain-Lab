/**
 * Headless checks for Pass 5 live-QA leftovers (session JQQC4D):
 * hashrate on instant finds, way-too-fast difficulty, late miner names,
 * bounded chain DOM.
 * Usage: node scripts/pass5-live-fix-test.js
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

// --- 1. Instant-find worker messages include a non-zero hashrate ---
(function () {
  const participate = loadFile('public/javascripts/lab/participate.js');
  const worker = loadFile('public/javascripts/lab/miningWorker.js');
  const inlineFound = /type:\s*'found'[\s\S]{0,220}hashrate/.test(participate);
  const fileFound = /type:\s*'found'[\s\S]{0,220}hashrate/.test(worker);
  const applyLocal = /function applyLocalHashrate/.test(participate);
  const emitOnFound = /maybeEmitHashrate\(foundHr/.test(participate);
  if (inlineFound && fileFound && applyLocal && emitOnFound) {
    pass('Worker found-path publishes hashrate (inline + file)', '');
  } else {
    fail('Worker found-path publishes hashrate (inline + file)',
      'inline=' + inlineFound + ' file=' + fileFound + ' apply=' + applyLocal + ' emit=' + emitOnFound);
  }
})();

// --- 2. Pause still zeros hashrate; live updateHashrate is non-zero ---
(function () {
  const lab = new Relay('HR');
  lab.addOrUpdateParticipant('miner-1', 'miner', { name: 'Miner 1' });
  lab.updateHashrate('miner-1', 12000);
  if (lab.networkStats.totalHashrate === 12000 && lab.participants.get('miner-1').hashrate === 12000) {
    pass('Live miner hashrate is stored and totaled', '12000');
  } else {
    fail('Live miner hashrate is stored and totaled', String(lab.networkStats.totalHashrate));
  }
  lab.networkPaused = true;
  lab.zeroHashratesForPause();
  if (lab.networkStats.totalHashrate === 0 && lab.participants.get('miner-1').hashrate === 0) {
    pass('Pause still zeros displayed hashrate', '0');
  } else {
    fail('Pause still zeros displayed hashrate', String(lab.networkStats.totalHashrate));
  }
  lab.updateHashrate('miner-1', 12000);
  if (lab.networkStats.totalHashrate === 0) pass('Paused hub still ignores inbound hashrate', '0');
  else fail('Paused hub still ignores inbound hashrate', String(lab.networkStats.totalHashrate));
})();

// --- 3. Way-too-fast median adds exactly one leading zero, not 1→4 ---
(function () {
  const lab = new Relay('FASTZERO');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: 1,
    difficultySecondary: 2
  });
  lab.networkStats.blockIntervals = [300, 400, 350];
  lab.networkStats.totalHashrate = 0;
  const s = lab.maybeRetargetDifficulty();
  if (s && s.difficultyLeading === 2 && Number(s.difficultySecondary) === 2) {
    pass('0.3s median adds one leading zero (1+0x2 → 2+0x2)',
      s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16));
  } else {
    fail('0.3s median adds one leading zero (1+0x2 → 2+0x2)',
      s ? (s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16)) : 'no change');
  }
})();

// --- 4. One retarget cannot jump 1→4 even when hashrate implies 5 zeros ---
(function () {
  const lab = new Relay('NOJUMP');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: 1,
    difficultySecondary: 3
  });
  lab.networkStats.totalHashrate = 18000;
  lab.networkStats.blockIntervals = [250, 250, 300];
  const s = lab.maybeRetargetDifficulty();
  if (s && s.difficultyLeading <= 2) {
    pass('Way-too-fast + 18kH/s still max +1 leading zero',
      s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16));
  } else {
    fail('Way-too-fast + 18kH/s still max +1 leading zero',
      s ? (s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16)) : 'no change');
  }
})();

// --- 5. Cooldown still blocks a burst of tip extensions ---
(function () {
  const lab = new Relay('FASTCD');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: 1,
    difficultySecondary: 3
  });
  let changes = 0;
  let maxL = 1;
  for (let i = 0; i < 15; i++) {
    lab.networkStats.blockIntervals = [250, 250, 250];
    const s = lab.maybeRetargetDifficulty();
    if (s) {
      changes += 1;
      maxL = Math.max(maxL, s.difficultyLeading);
    }
  }
  if (changes <= 1 && maxL <= 2) {
    pass('Cooldown: 15 fast samples → one zero step',
      'changes=' + changes + ' maxL=' + maxL);
  } else {
    fail('Cooldown: 15 fast samples → one zero step',
      'changes=' + changes + ' maxL=' + maxL);
  }
})();

// --- 6. Empty first presence then a later name overwrites Unnamed ---
(function () {
  const lab = new Relay('LATENAME');
  lab.addOrUpdateParticipant('user_o01bmzh3d', 'miner', { name: null, displayName: null });
  lab.addOrUpdateParticipant('user_o01bmzh3d', 'miner', { hashrate: 0, status: 'idle' });
  let p = lab.participants.get('user_o01bmzh3d');
  if (p && !(p.displayName || p.name)) {
    pass('First empty presence stays unnamed', '');
  } else {
    fail('First empty presence stays unnamed', p ? JSON.stringify(p) : 'missing');
  }
  lab.addOrUpdateParticipant('user_o01bmzh3d', 'miner', {
    name: 'Miner 2',
    displayName: 'Miner 2'
  });
  p = lab.participants.get('user_o01bmzh3d');
  if (p && p.displayName === 'Miner 2' && p.name === 'Miner 2') {
    pass('Later name overwrites empty/Unnamed latch', p.displayName);
  } else {
    fail('Later name overwrites empty/Unnamed latch', p ? JSON.stringify(p) : 'missing');
  }
  lab.addOrUpdateParticipant('user_1b4dnnbwz', 'miner', { name: 'Miner 1', displayName: 'Miner 1' });
  lab.addOrUpdateParticipant('user_1b4dnnbwz', 'miner', { name: 'Miner 2', displayName: 'Miner 2' });
  const other = lab.participants.get('user_1b4dnnbwz');
  if (other && other.displayName === 'Miner 1') {
    pass('Later join does not overwrite a different miner name', other.displayName);
  } else {
    fail('Later join does not overwrite a different miner name', other ? other.displayName : 'missing');
  }
})();

// --- 7. Miner tab types name on blur / input (not Save-only) ---
(function () {
  const participate = loadFile('public/javascripts/lab/participate.js');
  const observe = loadFile('public/javascripts/lab/observe.js');
  const admin = loadFile('public/javascripts/lab/admin.js');
  const coord = loadFile('public/javascripts/network/AdminRelayCoordinator.js');
  const blur = /#nodeName'\)\.on\('blur'/.test(participate) && /scheduleBroadcastTypedName/.test(participate);
  const miningName = /function emitMiningOnBlock/.test(participate) && /displayName/.test(participate);
  const hubMining = /applyInboundDisplayName\(msg\)/.test(admin);
  const coordName = /incomingName/.test(coord) && /addOrUpdateParticipant/.test(coord);
  const walletBlur = /#nodeName'\)\.on\('blur'/.test(observe);
  if (blur && miningName && hubMining && coordName && walletBlur) {
    pass('Name path: blur/input + mining/block payload + hub apply', '');
  } else {
    fail('Name path: blur/input + mining/block payload + hub apply',
      JSON.stringify({ blur: blur, miningName: miningName, hubMining: hubMining, coordName: coordName, walletBlur: walletBlur }));
  }
})();

// --- 8. 200-block chain HTML is windowed (genesis + last N) ---
(function () {
  const blocks = [];
  for (let i = 0; i <= 200; i++) {
    blocks.push(makeBlock(i, 'h' + i, i === 0 ? '0' : 'h' + (i - 1)));
  }
  const win = ChainDisplay.windowBlocksForDisplay(blocks, 24);
  if (win.blocks.length <= 24 && win.omitted >= 170 && win.keptGenesis) {
    pass('windowBlocksForDisplay keeps genesis + last N of 201',
      'visible=' + win.blocks.length + ' omitted=' + win.omitted);
  } else {
    fail('windowBlocksForDisplay keeps genesis + last N of 201',
      JSON.stringify(win && { n: win.blocks.length, omitted: win.omitted, g: win.keptGenesis }));
  }
  const html = ChainDisplay.renderChainHtml({ mainChain: blocks, orphans: [], participants: [] });
  const blockCards = (html.match(/Block #/g) || []).length;
  const hasOmitted = /earlier block/.test(html);
  const hasGenesis = /Block #0/.test(html);
  const hasTip = /Block #200/.test(html);
  const hasMid = /Block #50/.test(html);
  if (blockCards <= 26 && hasOmitted && hasGenesis && hasTip && !hasMid) {
    pass('renderChainHtml caps DOM at ~24 cards for height 200',
      'cards=' + blockCards);
  } else {
    fail('renderChainHtml caps DOM at ~24 cards for height 200',
      'cards=' + blockCards + ' omitted=' + hasOmitted + ' genesis=' + hasGenesis + ' tip=' + hasTip + ' mid=' + hasMid);
  }
})();

// --- 9. Overview height still uses the full tip, not the window ---
(function () {
  const suffix = [];
  suffix.push(makeBlock(0, 'h0', '0'));
  for (let i = 180; i <= 200; i++) suffix.push(makeBlock(i, 'h' + i, 'h' + (i - 1)));
  const h = Relay.resolveOverviewHeight(suffix, { tipIndex: 200, networkStats: { blockHeight: 200 } }, 200);
  if (h === 200) pass('Overview height stays at tip 200 with windowed copy', String(h));
  else fail('Overview height stays at tip 200 with windowed copy', String(h));
})();

// --- 10. Wall-clock tip pace records intervals even when timestamps collide ---
(function () {
  const lab = new Relay('PACEWALL');
  lab.updateSettings({ autoDifficulty: true, targetBlockTimeSec: 10, difficultyLeading: 1, difficultySecondary: 2 });
  lab.ensureGenesis();
  lab.chain.push(makeBlock(1, '0aaa', lab.chain[0].hash, { miner: 'm1', timestamp: Date.now() }));
  lab.chain.push(makeBlock(2, '0bbb', '0aaa', { miner: 'm2', timestamp: Date.now() }));
  lab.networkStats._lastTipWallClock = Date.now() - 400;
  lab._recordTipPace();
  const n = (lab.networkStats.blockIntervals || []).length;
  const last = n ? lab.networkStats.blockIntervals[n - 1] : 0;
  if (n >= 1 && last >= 250) pass('Wall-clock tip pace records a capped interval', last + 'ms');
  else fail('Wall-clock tip pace records a capped interval', 'n=' + n + ' last=' + last);
})();

const failed = results.filter(function (r) { return !r.ok; });
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
