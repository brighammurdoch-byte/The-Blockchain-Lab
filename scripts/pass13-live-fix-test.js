/**
 * Headless checks for Pass 13 Chrome Aw Snap error 9 (hub 0HU8XV + wallet O5E46U):
 * hard chain-card / orphan caps, no full-chain serialize on race losers,
 * D3 packet-flood cap, held leftover-URL / prune / stall-ease / join stagger.
 * Existing pass1–pass12 stay green. Usage: node scripts/pass13-live-fix-test.js
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

// --- 1. Hard card cap: height 200 + 5 race-losers per height ---
(function () {
  const main = [];
  const orphans = [];
  for (let i = 0; i <= 200; i++) {
    main.push(makeBlock(i, 'h' + i, i === 0 ? '0' : 'h' + (i - 1)));
    if (i === 0) continue;
    for (let m = 2; m <= 6; m++) {
      orphans.push(makeBlock(i, 'o' + i + 'm' + m, 'h' + (i - 1), { miner: 'miner-' + m }));
    }
  }
  const html = ChainDisplay.renderChainHtml({
    mainChain: main,
    orphans: orphans,
    participants: [],
    maxVisible: 24
  });
  const cards = (html.match(/Block #/g) || []).length;
  const hasOmitted = /earlier block/.test(html);
  const hasGenesis = /Block #0/.test(html);
  const hasTip = /Block #200/.test(html);
  const hasMid = /Block #50/.test(html);
  const cap = ChainDisplay.MAX_TOTAL_CARDS || 14;
  if (cards <= cap && hasOmitted && hasGenesis && hasTip && !hasMid) {
    pass('renderChainHtml hard-caps cards even with 5 orphans/height at 200',
      'cards=' + cards + ' cap=' + cap);
  } else {
    fail('renderChainHtml hard-caps cards even with 5 orphans/height at 200',
      'cards=' + cards + ' omitted=' + hasOmitted + ' genesis=' + hasGenesis +
      ' tip=' + hasTip + ' mid=' + hasMid + ' cap=' + cap);
  }
  if (ChainDisplay.HARD_MAX_VISIBLE <= 10 && ChainDisplay.MAX_ORPHAN_CARDS <= 8) {
    pass('ChainDisplay exports hard visible / orphan caps',
      'visible=' + ChainDisplay.HARD_MAX_VISIBLE + ' orphans=' + ChainDisplay.MAX_ORPHAN_CARDS);
  } else {
    fail('ChainDisplay exports hard visible / orphan caps',
      JSON.stringify({
        HARD_MAX_VISIBLE: ChainDisplay.HARD_MAX_VISIBLE,
        MAX_ORPHAN_CARDS: ChainDisplay.MAX_ORPHAN_CARDS
      }));
  }
})();

// --- 2. Explicit windowBlocksForDisplay(24) still works (pass5 hook) ---
(function () {
  const blocks = [];
  for (let i = 0; i <= 200; i++) blocks.push(makeBlock(i, 'h' + i, i === 0 ? '0' : 'h' + (i - 1)));
  const win = ChainDisplay.windowBlocksForDisplay(blocks, 24);
  if (win.blocks.length <= 24 && win.omitted >= 170 && win.keptGenesis) {
    pass('windowBlocksForDisplay(24) still keeps genesis + last N',
      'visible=' + win.blocks.length + ' omitted=' + win.omitted);
  } else {
    fail('windowBlocksForDisplay(24) still keeps genesis + last N',
      JSON.stringify(win && { n: win.blocks.length, omitted: win.omitted, g: win.keptGenesis }));
  }
})();

// --- 2b. Hidden earlier blocks stay listed in the archive control ---
(function () {
  const main = [];
  for (let i = 0; i <= 200; i++) main.push(makeBlock(i, 'h' + i, i === 0 ? '0' : 'h' + (i - 1)));
  const html = ChainDisplay.renderChainHtml({
    mainChain: main,
    orphans: [],
    participants: [],
    maxVisible: 24
  });
  const hasBrowse = /Browse \d+ earlier block/.test(html);
  const hasArchiveRow = /data-chain-archive-hash="h50"/.test(html);
  const midAsCard = /<strong>Block #50<\/strong>/.test(html);
  const cards = (html.match(/<strong>Block #/g) || []).length;
  const cap = ChainDisplay.MAX_TOTAL_CARDS || 14;
  if (hasBrowse && hasArchiveRow && !midAsCard && cards <= cap) {
    pass('omitted heights stay browseable without extra live cards',
      'browse=' + hasBrowse + ' archive#50=' + hasArchiveRow + ' cards=' + cards);
  } else {
    fail('omitted heights stay browseable without extra live cards',
      'browse=' + hasBrowse + ' archive#50=' + hasArchiveRow + ' midCard=' + midAsCard + ' cards=' + cards);
  }
  const lab = new Relay();
  if (lab.settings.difficultyLeading === 3 && lab.settings.difficultySecondary === 8) {
    pass('default difficulty is 3 leading zeros + 0x8',
      lab.settings.difficultyLeading + '+0x' + lab.settings.difficultySecondary.toString(16));
  } else {
    fail('default difficulty is 3 leading zeros + 0x8',
      JSON.stringify({
        L: lab.settings.difficultyLeading,
        S: lab.settings.difficultySecondary
      }));
  }
})();

// --- 3. compactChainForTransport does not stringify a 90-block chain ---
(function () {
  const lab = new Relay();
  lab.chain = [];
  for (let i = 0; i <= 90; i++) lab.chain.push(makeBlock(i, 'h' + i, i === 0 ? '0' : 'h' + (i - 1)));
  const orig = JSON.stringify;
  let stringifyCount = 0;
  JSON.stringify = function () {
    stringifyCount += 1;
    return orig.apply(JSON, arguments);
  };
  let packed;
  try {
    packed = lab.compactChainForTransport(50000);
  } finally {
    JSON.stringify = orig;
  }
  if (packed && packed.chainTruncated && packed.chain.length <= 20 && stringifyCount === 0) {
    pass('compactChainForTransport truncates height 90 without JSON.stringify',
      'n=' + packed.chain.length);
  } else {
    fail('compactChainForTransport truncates height 90 without JSON.stringify',
      JSON.stringify({
        truncated: packed && packed.chainTruncated,
        n: packed && packed.chain.length,
        stringifyCount: stringifyCount
      }));
  }
})();

// --- 4. Race-loser block-accepted does not treat isFork as needFullChain ---
(function () {
  const coord = loadFile('public/javascripts/network/AdminRelayCoordinator.js');
  const noForkFull = /needFullChain = !!\(result\.reorg \|\| !result\.tipChanged \|\| hardForkLive\)/.test(coord);
  const comment = /Race losers \(isFork without reorg\)/.test(coord);
  const cheapOrphans = /cheapOrphans/.test(coord) && /slice\(-12\)/.test(coord);
  if (noForkFull && comment && cheapOrphans) {
    pass('Coordinator skips full-chain serialize on race-loser isFork', '');
  } else {
    fail('Coordinator skips full-chain serialize on race-loser isFork',
      JSON.stringify({ noForkFull: noForkFull, comment: comment, cheapOrphans: cheapOrphans }));
  }
})();

// --- 5. D3 flood cap + hub skips propagation on isFork ---
(function () {
  const viz = loadFile('public/javascripts/lab/networkVisualization.js');
  const admin = loadFile('public/javascripts/lab/admin.js');
  const flood = /shouldStartFlood/.test(viz)
    && /maxInflightPackets = 6/.test(viz)
    && /floodMinIntervalMs = 1100/.test(viz);
  const skipFork = /!payload\.isFork && relayState && typeof viz\.animateBlockPropagation/.test(admin);
  if (flood && skipFork) {
    pass('D3 packet floods are capped; hub skips gossip on race losers', '');
  } else {
    fail('D3 packet floods are capped; hub skips gossip on race losers',
      JSON.stringify({ flood: flood, skipFork: skipFork }));
  }
})();

// --- 6. Wallet / hub skip identical chain paints; no auto-reload hide ---
(function () {
  const observe = loadFile('public/javascripts/lab/observe.js');
  const admin = loadFile('public/javascripts/lab/admin.js');
  const skipObs = /_observerChainPaintKey/.test(observe) && /_observerRosterKey/.test(observe);
  const skipHub = /_hubChainPaintKey/.test(admin);
  const noReload = !/location\.reload\(/.test(observe) && !/location\.reload\(/.test(admin);
  if (skipObs && skipHub && noReload) {
    pass('Observe/admin skip identical chain paints; no crash auto-reload', '');
  } else {
    fail('Observe/admin skip identical chain paints; no crash auto-reload',
      JSON.stringify({ skipObs: skipObs, skipHub: skipHub, noReload: noReload }));
  }
})();

// --- 7. Held: leftover-URL rehost, quota prune, stall-ease / join stagger ---
(function () {
  const admin = loadFile('public/javascripts/lab/admin.js');
  const persist = loadFile('public/javascripts/network/Persistence.js');
  const leftoverGate = /function adminShouldHostSession/.test(admin)
    && /function adminTabOwnsHub/.test(admin)
    && /adminShouldHostSession\(sessionId\)/.test(admin)
    && /adminTabOwnsHub\(sessionId\)/.test(admin)
    && /location\.replace/.test(admin)
    && !/\.createRoom\(/.test(admin);
  const prune = /pruneLeftoverClassroomKeys/.test(persist)
    && /setLocalItem/.test(persist)
    && /Never localStorage\.clear/.test(persist);
  const held = /scheduleJoinUiPaints/.test(admin)
    && /Join toast must not rebuild/.test(admin)
    && /labAdminLiveHub_/.test(admin)
    && /easing after a stall/.test(admin);
  if (leftoverGate && prune && held) {
    pass('Held leftover-URL rehost, quota prune, stall-ease / join stagger stay', '');
  } else {
    fail('Held leftover-URL rehost, quota prune, stall-ease / join stagger stay',
      JSON.stringify({ leftoverGate: leftoverGate, prune: prune, held: held }));
  }
})();

// --- 8. Cache-bust p4fix11 on changed assets; held p4fix10 on the rest ---
(function () {
  const adminPug = loadFile('views/lab/admin.pug');
  const partPug = loadFile('views/lab/participate.pug');
  const obsPug = loadFile('views/lab/observe.pug');
  const indexPug = loadFile('views/lab/index.pug');
  const btcPug = loadFile('views/lab/bitcoin.pug');
  const ok =
    /chainDisplay\.js\?v=p4fix11/.test(adminPug + partPug + obsPug) &&
    /observe\.js\?v=p4fix10/.test(obsPug) &&
    /admin\.js\?v=p4fix11/.test(adminPug) &&
    /participate\.js\?v=p4fix11/.test(partPug) &&
    /networkVisualization\.js\?v=p4fix10/.test(adminPug) &&
    /AdminRelayCoordinator\.js\?v=p4fix10/.test(adminPug + partPug + obsPug + indexPug + btcPug) &&
    /RelayBlockchainState\.js\?v=p4fix11/.test(adminPug + partPug + obsPug + indexPug + btcPug);
  if (ok) pass('Edited scripts cache-bust p4fix11', '');
  else fail('Edited scripts cache-bust p4fix11', 'stale ?v=');
})();

const failed = results.filter(function (r) { return !r.ok; });
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
