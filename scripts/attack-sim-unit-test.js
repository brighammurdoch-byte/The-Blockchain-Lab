/**
 * 51% simulator: real hub fork choice, and winners come from the RNG.
 * Usage: node scripts/attack-sim-unit-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(rel) {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  return src;
}

const ctx = { window: {}, console, Math, Date, Map, Set, Object, Array, Number, String, isFinite, parseInt };
ctx.globalThis = ctx.window;
vm.createContext(ctx);
vm.runInContext(load('public/javascripts/network/RelayBlockchainState.js'), ctx);
vm.runInContext(load('public/javascripts/lab/attackSim.js'), ctx);

const Relay = ctx.window.RelayBlockchainState;
const Sim = ctx.window.AttackSim;

const results = [];
function pass(n, d) { results.push({ ok: true, n, d }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); }
function fail(n, d) { results.push({ ok: false, n, d }); console.log('FAIL  ' + n + ' — ' + d); }

function close(a, b, eps) {
  return Math.abs(a - b) <= (eps == null ? 1e-9 : eps);
}

function scripted(values) {
  let i = 0;
  return function () {
    if (i >= values.length) throw new Error('rng exhausted at draw ' + i);
    return values[i++];
  };
}

(function shares() {
  try {
    const pct = Sim.parseShares('30, 45, 55, 70');
    const expect = [0.3, 0.45, 0.55, 0.7];
    if (pct.length === 4 && pct.every((n, i) => close(n, expect[i]))) {
      pass('Comma shares are percents', pct.map(Sim.formatShare).join(' '));
    } else fail('Comma shares are percents', JSON.stringify(pct));
  } catch (e) { fail('Comma shares are percents', e.message); }

  try {
    const frac = Sim.parseShares('0.30 0.45, 1');
    if (frac.length === 3 && close(frac[0], 0.3) && close(frac[1], 0.45) && close(frac[2], 1)) {
      pass('Values at most 1 are fractions', frac.map(Sim.formatShare).join(' '));
    } else fail('Values at most 1 are fractions', JSON.stringify(frac));
  } catch (e) { fail('Values at most 1 are fractions', e.message); }

  ['', 'abc', '101', '-4', '30, nope'].forEach((bad) => {
    try {
      Sim.parseShares(bad);
      fail('Reject bad shares ' + JSON.stringify(bad), 'accepted');
    } catch (e) {
      pass('Reject bad shares ' + JSON.stringify(bad), e.message);
    }
  });
})();

(function rng() {
  const a = Sim.createRng(12345);
  const b = Sim.createRng('12345');
  const seqA = [a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b()];
  if (seqA.every((n, i) => n === seqB[i]) && seqA.every((n) => n >= 0 && n < 1)) {
    pass('Numeric seed replays', seqA.map((n) => n.toFixed(4)).join(' '));
  } else fail('Numeric seed replays', JSON.stringify(seqA) + ' vs ' + JSON.stringify(seqB));

  const blank = Sim.createRng('');
  const sample = blank();
  if (!blank.seeded && sample >= 0 && sample < 1) pass('Blank seed uses Math.random', '');
  else fail('Blank seed uses Math.random', 'seeded=' + blank.seeded + ' sample=' + sample);

  const s1 = Sim.createRng(1);
  const s2 = Sim.createRng(2);
  const q1 = [s1(), s1(), s1(), s1(), s1()];
  const q2 = [s2(), s2(), s2(), s2(), s2()];
  if (q1.some((n, i) => n !== q2[i])) pass('Different seeds diverge', '');
  else fail('Different seeds diverge', q1.join(','));
})();

(function hubLimit() {
  const state = new Relay('LIMIT');
  state.updateSettings({ autoDifficulty: false, difficultyLeading: 1, difficultySecondary: 15 });
  state.ensureGenesis();
  let seq = 1;
  function seal(fields) {
    const block = Object.assign({
      timestamp: seq,
      nonce: 0,
      transactions: [],
      difficulty: 1
    }, fields);
    let nonce = 0;
    let hash = '';
    for (; nonce < 200000; nonce++) {
      block.nonce = nonce;
      hash = Relay.hashBlock(block);
      if (Relay.prototype.hashMeetsDifficulty(hash, 1, 15)) break;
    }
    if (!Relay.prototype.hashMeetsDifficulty(hash, 1, 15)) {
      throw new Error('fixture nonce search failed');
    }
    block.hash = hash;
    seq += 1;
    return block;
  }
  function addHonest() {
    const tip = state.chain[state.chain.length - 1];
    return state.tryAddBlock(seal({
      index: tip.index + 1,
      previousHash: tip.hash,
      miner: 'honest'
    }), 'honest');
  }
  // Tip must sit 11 above some parent: the hub rejects tipIndex - parentIndex > 10.
  for (let i = 0; i < 12; i++) {
    const r = addHonest();
    if (!r.accepted) {
      fail('Honest pre-chain accepted', r.reason);
      return;
    }
  }
  const tip = state.chain[state.chain.length - 1];
  function onParent(behind) {
    const parent = state.chain[state.chain.length - 1 - behind];
    return state.tryAddBlock(seal({
      index: parent.index + 1,
      previousHash: parent.hash,
      miner: 'attacker'
    }), 'attacker');
  }
  const stale = onParent(11);
  if (!stale.accepted && /stale parent/i.test(stale.reason || '')) {
    pass('Hub rejects a parent 11 behind', stale.reason);
  } else fail('Hub rejects a parent 11 behind', JSON.stringify(stale.accepted) + ' ' + stale.reason);

  const ok = onParent(4);
  if (ok.accepted) pass('Hub still accepts a parent 4 behind', 'tip ' + tip.index);
  else fail('Hub still accepts a parent 4 behind', ok.reason);

  if (Sim.STALE_GAP === 11 && Sim.STALE_PARENT_LIMIT === 10) {
    pass('Simulator gap matches the hub rule', 'stop at ' + Sim.STALE_GAP);
  } else fail('Simulator gap matches the hub rule', Sim.STALE_GAP + '/' + Sim.STALE_PARENT_LIMIT);
})();

(function scriptedOutcomes() {
  function base(extra) {
    return Object.assign({
      preChain: 10,
      avgBlockTime: 10,
      giveUp: 5,
      Relay: Relay
    }, extra);
  }

  [1, 2, 3].forEach((back) => {
    const win = Sim.runTrial(base({
      share: 1,
      back: back,
      rnd: scripted([0.2, 0.5, 0.2, 0.5, 0.2, 0.5, 0.2, 0.5])
    }));
    const wantBlocks = back + 1;
    if (win.ok && win.attackerBlocks === wantBlocks && win.honestBlocks === 0 &&
        win.reason === 'Reorg at block 11' && win.tipMiner === 'attacker' && win.tipIndex === 11) {
      pass('100% share reorgs from ' + back + ' back', win.attackerBlocks + ' attacker blocks');
    } else {
      fail('100% share reorgs from ' + back + ' back', JSON.stringify(win));
    }

    const loseDraws = [];
    for (let i = 0; i < (5 - back); i++) loseDraws.push(0.2, 0.9);
    const lose = Sim.runTrial(base({ share: 0, back: back, rnd: scripted(loseDraws) }));
    if (!lose.ok && lose.attackerBlocks === 0 && lose.honestBlocks === (5 - back) &&
        lose.reason === 'Fell 5 behind' && lose.tipMiner === 'honest') {
      pass('0% share falls 5 behind from ' + back + ' back', lose.honestBlocks + ' honest blocks');
    } else {
      fail('0% share falls 5 behind from ' + back + ' back', JSON.stringify(lose));
    }
  });

  const early = Sim.runTrial(base({
    share: 0,
    back: 1,
    giveUp: 3,
    rnd: scripted([0.2, 0.9, 0.2, 0.9])
  }));
  if (!early.ok && early.reason === 'Fell 3 behind' && early.honestBlocks === 2 && early.stopAt === 3) {
    pass('Smaller give-up quits before the hub wall', early.reason);
  } else fail('Smaller give-up quits before the hub wall', JSON.stringify(early));

  // Gap starts at 1. Ten honest finds reach gap 11, then the loop stops before another draw.
  const deepDraws = [];
  for (let i = 0; i < 10; i++) deepDraws.push(0.4, 0.99);
  const deep = Sim.runTrial(base({
    share: 0.3,
    back: 1,
    giveUp: 20,
    rnd: scripted(deepDraws)
  }));
  if (!deep.ok && deep.reason === 'Fell 11 behind' && deep.stopAt === 11 && deep.honestBlocks === 10) {
    pass('Give-up past the wall still dies on the stale-parent wall', deep.reason);
  } else fail('Give-up past the wall still dies on the stale-parent wall', JSON.stringify(deep));

  // Tie at equal height is not a win (hub keeps the first-seen chain).
  const tie = Sim.runTrial(base({
    share: 1,
    back: 1,
    maxEvents: 1,
    rnd: scripted([0.2, 0.0])
  }));
  if (!tie.ok && tie.attackerBlocks === 1 && tie.honestBlocks === 0 && tie.reason === 'Reached the block limit') {
    pass('Equal height stays with the honest chain', tie.reason);
  } else fail('Equal height stays with the honest chain', JSON.stringify(tie));

  // back 1: attacker, honest, attacker ties again, attacker pulls ahead.
  const mixed = Sim.runTrial(base({
    share: 0.5,
    back: 1,
    rnd: scripted([0.25, 0.1, 0.25, 0.9, 0.25, 0.1, 0.25, 0.1])
  }));
  if (mixed.ok && mixed.attackerBlocks === 3 && mixed.honestBlocks === 1 && mixed.reason === 'Reorg at block 12' && mixed.tipMiner === 'attacker') {
    pass('Scripted luck decides the winner', mixed.attackerBlocks + 'A/' + mixed.honestBlocks + 'H ' + mixed.reason);
  } else fail('Scripted luck decides the winner', JSON.stringify(mixed));

  try {
    Sim.runTrial(base({ share: 0.5, back: 3, giveUp: 3, rnd: scripted([]) }));
    fail('Give-up must be deeper than the start', 'accepted');
  } catch (e) {
    pass('Give-up must be deeper than the start', e.message);
  }
})();

(function seededStudy() {
  const opts = {
    shares: [0.3, 0.7],
    trials: 12,
    back: 2,
    preChain: 10,
    avgBlockTime: 10,
    giveUp: 5
  };
  const a = Sim.runStudy(Object.assign({}, opts, { rnd: Sim.createRng(99) }));
  const b = Sim.runStudy(Object.assign({}, opts, { rnd: Sim.createRng(99) }));
  const sig = (study) => study.rows.map((r) => [r.ok, r.attackerBlocks, r.honestBlocks, r.reason].join(':')).join('|');
  if (sig(a) === sig(b) && a.rows.length === 24) pass('A seed repeats the whole study', a.rows.length + ' trials');
  else fail('A seed repeats the whole study', 'len ' + a.rows.length);

  const c = Sim.runStudy(Object.assign({}, opts, { rnd: Sim.createRng(100) }));
  if (sig(a) !== sig(c)) pass('Another seed is a different study', '');
  else fail('Another seed is a different study', 'identical');

  const both = a.rows.some((r) => r.ok) && a.rows.some((r) => !r.ok);
  if (both) pass('One seeded study contains wins and failures', '');
  else fail('One seeded study contains wins and failures', a.summary.map((s) => s.winRate).join(','));
})();

(function ordering() {
  const study = Sim.runStudy({
    shares: [0.3, 0.45, 0.55, 0.7],
    trials: 200,
    back: 2,
    preChain: 10,
    avgBlockTime: 10,
    giveUp: 5,
    rnd: Sim.createRng(20261013)
  });
  const rates = {};
  study.summary.forEach((row) => { rates[Sim.formatShare(row.share)] = row.winRate; });
  const line = study.summary.map((row) => Sim.formatShare(row.share) + '=' + (row.winRate * 100).toFixed(1) + '%').join('  ');
  const r30 = rates['30%'];
  const r45 = rates['45%'];
  const r55 = rates['55%'];
  const r70 = rates['70%'];
  if (r30 < r45 && r45 < r55 && r55 < r70 && r30 < 0.4 && r70 > 0.75) {
    pass('Higher hash share wins more often', line);
  } else {
    fail('Higher hash share wins more often', line);
  }
  study.rows.forEach((row) => {
    if (row.ok && row.tipMiner !== 'attacker') fail('Win tip is the attacker', JSON.stringify(row));
    if (!row.ok && row.reason.indexOf('Fell') === 0 && row.tipMiner !== 'honest') {
      fail('Failed tip stayed honest', JSON.stringify(row));
    }
  });
  if (!results.some((r) => !r.ok && /tip/.test(r.n))) {
    pass('Wins reorg onto the attacker; failures stay on the honest tip', study.rows.length + ' checked');
  }
})();

const failed = results.filter((r) => !r.ok).length;
console.log('\n==== attack-sim-unit-test: ' + (results.length - failed) + '/' + results.length + ' passed ====');
process.exit(failed ? 1 : 0);
