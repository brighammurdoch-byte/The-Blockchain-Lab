/**
 * Transaction verification: structure, session identity, balance, replay,
 * and block inclusion re-check.
 * Usage: node scripts/tx-verify-unit-test.js
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

const results = [];
function pass(n, d) { results.push({ ok: true, n, d }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); }
function fail(n, d) { results.push({ ok: false, n, d }); console.log('FAIL  ' + n + ' — ' + d); }

const Relay = loadRelay();

function labWith() {
  const lab = new Relay('TXVERIFY');
  lab.ensureGenesis();
  lab.updateSettings({ difficultyLeading: 1, difficultySecondary: 15, autoDifficulty: false, miningRewardCoins: 10 });
  lab.addOrUpdateParticipant('wallet-1', 'wallet', { endowment: 100, balance: 100 });
  lab.addOrUpdateParticipant('miner-1', 'miner', { endowment: 0, balance: 0 });
  lab.addOrUpdateParticipant('miner-2', 'miner', { endowment: 0, balance: 0 });
  return lab;
}

function block(index, hash, prev, extra) {
  return Object.assign({
    index: index,
    hash: hash,
    previousHash: prev,
    timestamp: Date.now(),
    nonce: 1,
    transactions: [],
    miner: 'miner-1'
  }, extra || {});
}

(function () {
  const lab = labWith();
  const bad = lab.tryAddTransaction({ from: 'wallet-1', to: 'miner-2', amount: 0 }, {
    requireSubmitter: true,
    submittedBy: 'wallet-1'
  });
  if (!bad.accepted && /positive number/i.test(bad.reason || '')) {
    pass('Reject non-positive amount', bad.reason);
  } else fail('Reject non-positive amount', JSON.stringify(bad));

  const self = lab.tryAddTransaction({ from: 'wallet-1', to: 'wallet-1', amount: 1, timestamp: 1 }, {
    requireSubmitter: true,
    submittedBy: 'wallet-1'
  });
  if (!self.accepted && /yourself/i.test(self.reason || '')) pass('Reject self-send', self.reason);
  else fail('Reject self-send', self.reason || 'accepted');

  const spoof = lab.tryAddTransaction({ from: 'wallet-1', to: 'miner-2', amount: 5, timestamp: 2, id: 'spoof' }, {
    requireSubmitter: true,
    submittedBy: 'miner-2'
  });
  if (!spoof.accepted && /own address/i.test(spoof.reason || '')) pass('Reject spend of someone else\'s address', spoof.reason);
  else fail('Reject spend of someone else\'s address', spoof.reason || 'accepted');

  const missing = lab.tryAddTransaction({ to: 'miner-2', amount: 1 }, { requireSubmitter: true, submittedBy: 'wallet-1' });
  if (!missing.accepted && /sender or recipient/i.test(missing.reason || '')) pass('Reject missing sender', missing.reason);
  else fail('Reject missing sender', missing.reason || 'accepted');
})();

(function () {
  const lab = labWith();
  const genesis = lab.chain[0];
  const tx = { id: 'ok-5', from: 'wallet-1', to: 'miner-2', amount: 5, timestamp: 1000 };
  const added = lab.tryAddTransaction(tx, { requireSubmitter: true, submittedBy: 'wallet-1' });
  if (!(added.accepted && added.verification && added.verification.valid)) {
    fail('Valid transfer enters mempool', added.reason || 'no verification');
    return;
  }
  pass('Valid transfer enters mempool', added.verification.reason);

  const over = lab.tryAddTransaction(
    { id: 'over', from: 'wallet-1', to: 'miner-2', amount: 96, timestamp: 1001 },
    { requireSubmitter: true, submittedBy: 'wallet-1' }
  );
  if (!over.accepted && /Insufficient balance/i.test(over.reason || '') && /already waiting/i.test(over.reason || '')) {
    pass('Second spend that exceeds balance is rejected', over.reason);
  } else fail('Second spend that exceeds balance is rejected', over.reason || 'accepted');

  const broke = lab.tryAddTransaction(
    { id: 'broke', from: 'miner-1', to: 'wallet-1', amount: 1, timestamp: 1002 },
    { requireSubmitter: true, submittedBy: 'miner-1' }
  );
  if (!broke.accepted && /Insufficient balance/i.test(broke.reason || '')) {
    pass('Miner with 0 coins cannot send', broke.reason);
  } else fail('Miner with 0 coins cannot send', broke.reason || 'accepted');

  const b1 = block(1, '0abc', genesis.hash, { miner: 'miner-1', transactions: [tx] });
  const r1 = lab.tryAddBlock(b1, 'miner-1');
  if (!r1.accepted) {
    fail('Valid tx included in a block', r1.reason);
    return;
  }
  const w = lab.participants.get('wallet-1');
  const m = lab.participants.get('miner-2');
  if (w && w.balance === 95 && m && m.balance === 5 && lab.pendingTransactions.length === 0) {
    pass('Included transfer confirms once', 'wallet ' + w.balance + ', miner2 ' + m.balance);
  } else {
    fail('Included transfer confirms once', JSON.stringify({
      w: w && w.balance,
      m: m && m.balance,
      pending: lab.pendingTransactions.length
    }));
  }

  const replay = lab.tryAddTransaction(tx, { requireSubmitter: true, submittedBy: 'wallet-1' });
  if (!replay.accepted && /replay|already confirmed/i.test(replay.reason || '')) {
    pass('Confirmed transfer cannot re-enter mempool', replay.reason);
  } else fail('Confirmed transfer cannot re-enter mempool', replay.reason || 'accepted');

  const again = block(2, '0def', b1.hash, {
    miner: 'miner-2',
    transactions: [{ from: 'wallet-1', to: 'miner-2', amount: 5, timestamp: 1000 }]
  });
  const r2 = lab.tryAddBlock(again, 'miner-2');
  if (!r2.accepted && /already on chain/i.test(r2.reason || '')) {
    pass('Block that replays a confirmed transfer is rejected', r2.reason);
  } else fail('Block that replays a confirmed transfer is rejected', r2.reason || 'accepted');
})();

(function () {
  const lab = labWith();
  const genesis = lab.chain[0];
  const txs = [
    { id: 'a', from: 'wallet-1', to: 'miner-2', amount: 60, timestamp: 3 },
    { id: 'b', from: 'wallet-1', to: 'miner-2', amount: 50, timestamp: 4 }
  ];
  const r = lab.tryAddBlock(block(1, '0bbb', genesis.hash, { transactions: txs, miner: 'miner-2' }), 'miner-2');
  if (!r.accepted && /Insufficient balance/i.test(r.reason || '') && r.txVerificationFailed) {
    pass('Block re-check rejects an overspend', r.reason);
  } else fail('Block re-check rejects an overspend', r.reason || 'accepted');
  const w = lab.participants.get('wallet-1');
  if (w && w.balance === 100) pass('Rejected block does not move balances', String(w.balance));
  else fail('Rejected block does not move balances', w ? String(w.balance) : 'missing');
})();

(function () {
  const lab = labWith();
  const genesis = lab.chain[0];
  const tx = { id: 'reward-spend', from: 'miner-1', to: 'wallet-1', amount: 10, timestamp: 8 };
  const r = lab.tryAddBlock(block(1, '0ccc', genesis.hash, { miner: 'miner-1', transactions: [tx] }), 'miner-1');
  const miner = lab.participants.get('miner-1');
  const wallet = lab.participants.get('wallet-1');
  if (r.accepted && miner && miner.balance === 0 && wallet && wallet.balance === 110) {
    pass('Block reward can fund a transfer in the same block', 'miner ' + miner.balance + ', wallet ' + wallet.balance);
  } else {
    fail('Block reward can fund a transfer in the same block', r.accepted ? JSON.stringify({
      miner: miner && miner.balance,
      wallet: wallet && wallet.balance
    }) : r.reason);
  }

  const lab2 = labWith();
  const tooMuch = { id: 'reward-over', from: 'miner-1', to: 'wallet-1', amount: 11, timestamp: 9 };
  const r2 = lab2.tryAddBlock(block(1, '0ddd', lab2.chain[0].hash, {
    miner: 'miner-1',
    transactions: [tooMuch]
  }), 'miner-1');
  if (!r2.accepted && /Insufficient balance/i.test(r2.reason || '')) {
    pass('Subsidy does not cover a larger same-block spend', r2.reason);
  } else fail('Subsidy does not cover a larger same-block spend', r2.reason || 'accepted');
})();

(function () {
  const screened = Relay.screenMempool([
    { id: 'keep', from: 'wallet-1', to: 'miner-2', amount: 40, timestamp: 1 },
    { id: 'drop', from: 'wallet-1', to: 'miner-2', amount: 70, timestamp: 2 }
  ], function () { return 100; });
  if (screened.kept.length === 1 && screened.kept[0].id === 'keep' && screened.dropped.length === 1) {
    pass('Miner screen keeps only the spendable prefix', screened.dropped[0].reason);
  } else fail('Miner screen keeps only the spendable prefix', JSON.stringify({
    kept: screened.kept.map(function (t) { return t.id; }),
    dropped: screened.dropped.length
  }));
})();

const failed = results.filter(function (r) { return !r.ok; });
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
