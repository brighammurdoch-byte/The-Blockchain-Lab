/**
 * Hub block acceptance: recomputed hash, and stale parents out to 10 back.
 * Usage: node scripts/block-acceptance-unit-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function run(src, ctx) {
  vm.runInContext(src, ctx);
}

const ctx = {
  window: {},
  console,
  Math,
  Date,
  Map,
  Set,
  Object,
  Array,
  Number,
  String,
  JSON,
  isFinite,
  parseInt
};
vm.createContext(ctx);
run(load('public/javascripts/network/RelayBlockchainState.js'), ctx);

const standalone = { Math, Date, Object, Array, String, JSON };
vm.createContext(standalone);
run(load('public/javascripts/lab/blockHash.js'), standalone);

const cryptoCtx = { Math, Date, Object, Array, String, JSON };
vm.createContext(cryptoCtx);
run(load('public/javascripts/lib/sha256.js'), cryptoCtx);
run(load('public/javascripts/lab/blockHash.js'), cryptoCtx);

const Relay = ctx.window.RelayBlockchainState;
const results = [];
function pass(n, d) { results.push({ ok: true, n, d }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); }
function fail(n, d) { results.push({ ok: false, n, d }); console.log('FAIL  ' + n + ' — ' + d); }

function lab() {
  const state = new Relay('HASH');
  state.ensureGenesis();
  state.updateSettings({ autoDifficulty: false, difficultyLeading: 1, difficultySecondary: 15 });
  state.addOrUpdateParticipant('wallet-1', 'wallet', { endowment: 100, balance: 100 });
  state.addOrUpdateParticipant('miner-1', 'miner', { endowment: 0, balance: 0 });
  return state;
}

function mine(fields) {
  const block = Object.assign({
    index: 1,
    timestamp: 1,
    nonce: 0,
    previousHash: '0',
    transactions: [],
    miner: 'miner-1',
    difficulty: 1
  }, fields);
  let nonce = 0;
  let hash = '';
  for (; nonce < 200000; nonce++) {
    block.nonce = nonce;
    hash = Relay.hashBlock(block);
    if (Relay.prototype.hashMeetsDifficulty(hash, 1, 15)) break;
  }
  block.hash = hash;
  block.nonce = nonce;
  return block;
}

(function helpersMatch() {
  const sample = {
    index: 3,
    timestamp: 99,
    nonce: 7,
    previousHash: 'abc',
    transactions: [{ to: 'b', from: 'a', amount: 2, timestamp: 5 }],
    miner: 'miner-1',
    difficulty: { leadingZeros: 1, secondaryHex: 'F' },
    forkId: 'classic'
  };
  const embedded = Relay.hashBlock(sample);
  const alone = standalone.LabBlockHash.hashBlock(sample);
  const viaCrypto = cryptoCtx.LabBlockHash.hashBlock(sample);
  if (embedded && embedded === alone && embedded === viaCrypto && /^[0-9a-f]{64}$/.test(embedded)) {
    pass('Hub digest matches blockHash.js and CryptoJS', embedded.slice(0, 12));
  } else {
    fail('Hub digest matches blockHash.js and CryptoJS', [embedded, alone, viaCrypto].join(' | '));
  }
})();

(function fakeHash() {
  const state = lab();
  const genesis = state.chain[0];
  const fake = '0000000000000000000000000000000000000000000000000000000000000001';
  const block = {
    index: 1,
    previousHash: genesis.hash,
    hash: fake,
    timestamp: 1,
    nonce: 0,
    transactions: [],
    miner: 'cheat',
    difficulty: 1
  };
  const result = state.tryAddBlock(block, 'cheat');
  const stored = state.allBlocks.has(fake);
  if (!result.accepted && /does not match block contents/i.test(result.reason || '') && !stored && state.chain.length === 1) {
    pass('Fake leading-zero hash is rejected', result.reason);
  } else {
    fail('Fake leading-zero hash is rejected', JSON.stringify({ accepted: result.accepted, reason: result.reason, stored: stored }));
  }
})();

(function honest() {
  const state = lab();
  const genesis = state.chain[0];
  const tx = { id: 'keep', from: 'wallet-1', to: 'miner-1', amount: 5, timestamp: 1000 };
  const block = mine({
    index: 1,
    previousHash: genesis.hash,
    transactions: [{ amount: tx.amount, timestamp: tx.timestamp, id: tx.id, to: tx.to, from: tx.from }],
    miner: 'miner-1'
  });
  const result = state.tryAddBlock(block, 'miner-1');
  const tip = state.chain[state.chain.length - 1];
  const wallet = state.participants.get('wallet-1');
  if (result.accepted && tip && tip.hash === block.hash && wallet && wallet.balance === 95) {
    pass('Honest mined block is accepted', 'tip ' + tip.index + ' wallet ' + wallet.balance);
  } else {
    fail('Honest mined block is accepted', result.accepted ? JSON.stringify({ tip: tip && tip.hash, balance: wallet && wallet.balance }) : result.reason);
  }
})();

(function tampered() {
  const state = lab();
  const genesis = state.chain[0];
  const tx = { id: 'keep', from: 'wallet-1', to: 'miner-1', amount: 5, timestamp: 1000 };
  const honestBlock = mine({
    index: 1,
    previousHash: genesis.hash,
    transactions: [tx],
    miner: 'miner-1'
  });
  const tamperedBlock = Object.assign({}, honestBlock, {
    transactions: [Object.assign({}, tx, { amount: 40 })]
  });
  const result = state.tryAddBlock(tamperedBlock, 'miner-1');
  const wallet = state.participants.get('wallet-1');
  if (!result.accepted && /does not match block contents/i.test(result.reason || '') && wallet && wallet.balance === 100 && state.chain.length === 1) {
    pass('Tampered transactions are rejected', result.reason);
  } else {
    fail('Tampered transactions are rejected', JSON.stringify({ accepted: result.accepted, reason: result.reason, balance: wallet && wallet.balance, height: state.chain.length }));
  }

  const over = mine({
    index: 1,
    previousHash: genesis.hash,
    miner: 'miner-1',
    transactions: [
      { id: 'a', from: 'wallet-1', to: 'miner-1', amount: 60, timestamp: 3 },
      { id: 'b', from: 'wallet-1', to: 'miner-1', amount: 50, timestamp: 4 }
    ]
  });
  const overResult = state.tryAddBlock(over, 'miner-1');
  if (!overResult.accepted && /Insufficient balance/i.test(overResult.reason || '') && overResult.txVerificationFailed) {
    pass('Re-mined overspend still fails the transfer check', overResult.reason);
  } else {
    fail('Re-mined overspend still fails the transfer check', overResult.reason || 'accepted');
  }
})();

(function staleDepth() {
  const state = lab();
  let seq = 0;
  function extendHonest() {
    const tip = state.chain[state.chain.length - 1];
    const block = mine({
      index: tip.index + 1,
      previousHash: tip.hash,
      timestamp: 1000 + seq,
      miner: 'honest'
    });
    seq += 1;
    const result = state.tryAddBlock(block, 'honest');
    if (!result.accepted) throw new Error(result.reason || 'honest rejected');
  }
  for (let i = 0; i < 12; i++) extendHonest();
  const tip = state.chain[state.chain.length - 1];
  [5, 6, 7, 8, 9, 10].forEach((behind) => {
    const parent = state.chain[state.chain.length - 1 - behind];
    const block = mine({
      index: parent.index + 1,
      previousHash: parent.hash,
      timestamp: 5000 + behind,
      miner: 'attacker'
    });
    const result = state.tryAddBlock(block, 'attacker');
    if (result.accepted) {
      pass('Fork from ' + behind + ' back is accepted', 'parent #' + parent.index + ' tip #' + tip.index);
    } else {
      fail('Fork from ' + behind + ' back is accepted', result.reason);
    }
  });
  const parent11 = state.chain[state.chain.length - 1 - 11];
  const tooFar = mine({
    index: parent11.index + 1,
    previousHash: parent11.hash,
    timestamp: 9000,
    miner: 'sleeper'
  });
  const rejected = state.tryAddBlock(tooFar, 'sleeper');
  if (!rejected.accepted && /stale parent/i.test(rejected.reason || '')) {
    pass('Fork from 11 back is still rejected', rejected.reason);
  } else {
    fail('Fork from 11 back is still rejected', JSON.stringify({ accepted: rejected.accepted, reason: rejected.reason }));
  }
  if (Relay.STALE_PARENT_LIMIT === 10) pass('Stale parent limit is the named constant 10', '');
  else fail('Stale parent limit is the named constant 10', String(Relay.STALE_PARENT_LIMIT));
})();

const failed = results.filter((r) => !r.ok).length;
console.log('\n==== block-acceptance-unit-test: ' + (results.length - failed) + '/' + results.length + ' passed ====');
process.exit(failed ? 1 : 0);
