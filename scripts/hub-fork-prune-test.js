/**
 * Long even fork race: pruneDistantOrphans must not delete a live
 * attacker branch, or a longer attacker chain can never reorg.
 * From hub-repro.js (40-round race). Usage: node scripts/hub-fork-prune-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const ctx = {
  window: {},
  console: { log() {}, warn() {}, error() {}, info() {} },
  Math,
  Date,
  Map,
  Set,
  Object,
  Array,
  Number,
  String,
  isFinite,
  parseInt
};
ctx.globalThis = ctx.window;
vm.createContext(ctx);
vm.runInContext(load('public/javascripts/network/RelayBlockchainState.js'), ctx);

const Relay = ctx.window.RelayBlockchainState;
const results = [];
function pass(n, d) { results.push({ ok: true, n, d }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); }
function fail(n, d) { results.push({ ok: false, n, d }); console.log('FAIL  ' + n + ' — ' + d); }

function mine(parent, miner, seq) {
  const b = {
    index: parent.index + 1,
    previousHash: parent.hash,
    timestamp: seq,
    nonce: 0,
    transactions: [],
    miner: miner,
    difficulty: 1
  };
  for (let n = 0; n < 200000; n++) {
    b.nonce = n;
    b.hash = Relay.hashBlock(b);
    if (Relay.prototype.hashMeetsDifficulty(b.hash, 1, 15)) break;
  }
  return b;
}

/**
 * Honest and attacker publish in lockstep, so the private tip stays 2 behind
 * (inside STALE_PARENT_LIMIT). Then the attacker finds 6 in a row.
 */
function race(honestRounds) {
  const s = new Relay('ROOM');
  s.updateSettings({ autoDifficulty: false, difficultyLeading: 1, difficultySecondary: 15 });
  s.ensureGenesis();
  let seq = 1;
  const tip = () => s.chain[s.chain.length - 1];
  for (let i = 0; i < 10; i++) {
    const res = s.tryAddBlock(mine(tip(), 'honest', seq++), 'honest');
    if (!res.accepted) return { err: 'honest setup rejected: ' + res.reason };
  }
  const fork = s.chain[s.chain.length - 1 - 2];
  let atk = fork;
  let anchor = null;
  for (let r = 0; r < honestRounds; r++) {
    const honest = s.tryAddBlock(mine(tip(), 'honest', seq++), 'honest');
    if (!honest.accepted) return { err: 'honest rejected r' + r + ': ' + honest.reason };
    const b = mine(atk, 'attacker', seq++);
    const res = s.tryAddBlock(b, 'attacker');
    if (!res.accepted) return { err: 'attacker rejected r' + r + ': ' + res.reason };
    atk = b;
    if (!anchor) anchor = b;
  }
  const before = {
    tip: tip().index,
    atk: atk.index,
    gap: tip().index - atk.index,
    anchorIndex: anchor.index,
    anchorStored: s.allBlocks.has(anchor.hash),
    path: (s._pathToGenesis(atk.hash) || []).length,
    stored: s.allBlocks.size,
    chain: s.chain.length
  };
  const packed = s.compactChainForTransport(50000);
  const persisted = s.getFullState();
  let reorgAt = null;
  const log = [];
  for (let k = 0; k < 6; k++) {
    const b = mine(atk, 'attacker', seq++);
    const res = s.tryAddBlock(b, 'attacker');
    log.push(b.index + ':' + (res.accepted ? 'acc' : 'rej ' + res.reason));
    atk = b;
    if (!res.accepted) break;
    if (s.chain.some((x) => x.hash === b.hash)) {
      reorgAt = b.index;
      break;
    }
  }
  return {
    before,
    packed,
    persistedHasAnchor: persisted.allBlocks.some((b) => b && b.hash === anchor.hash),
    reorgAt,
    log,
    tip: tip().index,
    tipMiner: tip().miner,
    atk: atk.index,
    anchorStored: s.allBlocks.has(anchor.hash),
    path: (s._pathToGenesis(atk.hash) || []).length
  };
}

(function fortyRoundReorg() {
  const out = race(40);
  if (out.err) {
    fail('40-round race accepts every published block', out.err);
    return;
  }
  const pastPrune = out.before.tip - out.before.anchorIndex > 32;
  const liveGap = out.before.gap <= Relay.STALE_PARENT_LIMIT;
  const pathOk = out.before.path === out.before.atk + 1;
  const storedBound = out.before.stored === out.before.chain + 40;
  if (pastPrune && liveGap && out.before.anchorStored && pathOk && storedBound &&
      out.before.tip === 50 && out.before.atk === 48 && out.before.gap === 2) {
    pass('40-round race keeps the live attacker branch past the 32-block prune',
      'tip ' + out.before.tip + ' atk ' + out.before.atk +
      ' anchorGap ' + (out.before.tip - out.before.anchorIndex) +
      ' stored ' + out.before.stored);
  } else {
    fail('40-round race keeps the live attacker branch past the 32-block prune',
      JSON.stringify(out.before));
  }

  if (out.persistedHasAnchor) {
    pass('localStorage snapshot keeps ancestors of the live tip', '');
  } else {
    fail('localStorage snapshot keeps ancestors of the live tip', 'anchor missing from getFullState');
  }

  if (out.packed && out.packed.chainTruncated && out.packed.chain.length <= 20) {
    pass('MQTT compactChainForTransport stays a canonical suffix',
      'n=' + out.packed.chain.length);
  } else {
    fail('MQTT compactChainForTransport stays a canonical suffix',
      JSON.stringify({
        truncated: out.packed && out.packed.chainTruncated,
        n: out.packed && out.packed.chain.length
      }));
  }

  if (out.reorgAt === 51 && out.tipMiner === 'attacker' && out.tip === 51 && out.path > 0) {
    pass('40-round race reorgs onto the longer attacker chain',
      'reorg at #' + out.reorgAt + ' tip ' + out.tipMiner + ' #' + out.tip);
  } else {
    fail('40-round race reorgs onto the longer attacker chain',
      JSON.stringify({ reorgAt: out.reorgAt, tip: out.tip, tipMiner: out.tipMiner, path: out.path, log: out.log }));
  }
})();

(function deadForkDrops() {
  const s = new Relay('DEAD');
  s.updateSettings({ autoDifficulty: false, difficultyLeading: 1, difficultySecondary: 15 });
  s.ensureGenesis();
  let seq = 1;
  const tip = () => s.chain[s.chain.length - 1];
  for (let i = 0; i < 10; i++) s.tryAddBlock(mine(tip(), 'honest', seq++), 'honest');
  let atk = s.chain[s.chain.length - 1 - 2];
  let anchor = null;
  for (let r = 0; r < 5; r++) {
    s.tryAddBlock(mine(tip(), 'honest', seq++), 'honest');
    const b = mine(atk, 'attacker', seq++);
    const res = s.tryAddBlock(b, 'attacker');
    if (!res.accepted) {
      fail('Dead-fork setup accepts the short attacker branch', res.reason);
      return;
    }
    atk = b;
    if (!anchor) anchor = b;
  }
  while (tip().index < 42) s.tryAddBlock(mine(tip(), 'honest', seq++), 'honest');
  const gap = tip().index - atk.index;
  const anchorGap = tip().index - anchor.index;
  const anchorGone = !s.allBlocks.has(anchor.hash);
  const mainKept = s.chain.every((b) => s.allBlocks.has(b.hash));
  const next = mine(atk, 'attacker', seq++);
  const rejected = s.tryAddBlock(next, 'attacker');
  // Tip is 42, anchor is 9 (33 behind) and is gone. The attacker tip at 13
  // is still inside keepBehind (29 behind) but outside the stale-parent window.
  const recentTailKept = s.allBlocks.has(atk.hash);
  if (gap > Relay.STALE_PARENT_LIMIT && anchorGap > 32 && anchorGone && mainKept &&
      recentTailKept && s.allBlocks.size < s.chain.length + 5 &&
      !rejected.accepted && /stale parent/i.test(rejected.reason || '')) {
    pass('Dead fork drops blocks only after its tip leaves the stale-parent window',
      'gap ' + gap + ' anchorGap ' + anchorGap + ' stored ' + s.allBlocks.size +
      ' chain ' + s.chain.length);
  } else {
    fail('Dead fork drops blocks only after its tip leaves the stale-parent window',
      JSON.stringify({
        gap: gap,
        anchorGap: anchorGap,
        anchorGone: anchorGone,
        mainKept: mainKept,
        recentTailKept: recentTailKept,
        stored: s.allBlocks.size,
        chain: s.chain.length,
        accepted: rejected.accepted,
        reason: rejected.reason
      }));
  }
})();

(function simulatorUsesHubPrune() {
  ['public/javascripts/lab/attackSim.js', 'docs/javascripts/lab/attackSim.js'].forEach((rel) => {
    const src = load(rel);
    if (/pruneDistantOrphans\s*=\s*function/.test(src)) {
      fail('Simulator uses real hub pruning (' + rel + ')', 'pruneDistantOrphans is replaced');
    } else {
      pass('Simulator uses real hub pruning (' + rel + ')', '');
    }
  });
})();

const failed = results.filter((r) => !r.ok).length;
console.log('\n==== hub-fork-prune-test: ' + (results.length - failed) + '/' + results.length + ' passed ====');
process.exit(failed ? 1 : 0);
