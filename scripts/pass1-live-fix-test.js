/**
 * Headless checks for Pass 1 live-classroom fixes:
 * join cancel, miner name persistence, pause hashrate, difficulty label.
 * Usage: node scripts/pass1-live-fix-test.js
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

function loadSessionProbe(NetworkManager) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public/javascripts/lab/sessionProbe.js'),
    'utf8'
  );
  const ctx = {
    window: { NetworkManager: NetworkManager },
    NetworkManager: NetworkManager,
    console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval
  };
  ctx.global = ctx;
  ctx.window.NetworkManager = NetworkManager;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.LabSessionProbe || ctx.LabSessionProbe;
}

class FakeNet {
  constructor() {
    this.handlers = {};
    this.userId = 'probe-test';
  }
  on(type, fn) { this.handlers[type] = this.handlers[type] || []; this.handlers[type].push(fn); }
  send() {}
  getPeerCount() { return 0; }
  disconnect() { this.disconnected = true; }
  joinRoom() { return new Promise(function () { /* hang until abort */ }); }
}

const Relay = loadRelay();

// --- 1. Join cancel aborts immediately and does not look like a timeout ---
(function () {
  const Probe = loadSessionProbe(function () { return new FakeNet(); });
  if (!Probe || typeof Probe.probeActiveSession !== 'function') {
    fail('sessionProbe loaded', 'missing LabSessionProbe');
    return;
  }
  const handle = {};
  const progress = [];
  const p = Probe.probeActiveSession('ZZZ999', {
    timeoutMs: 8000,
    handle: handle,
    onProgress: function (m) { progress.push(m); },
    shouldAbort: function () { return false; }
  });
  if (typeof handle.abort !== 'function') {
    fail('Cancel handle.abort is registered immediately', 'no abort');
    return;
  }
  handle.abort();
  return p.then(function () {
    fail('Cancel rejects (does not succeed)', 'resolved');
  }).catch(function (err) {
    if (err && err.cancelled) pass('Cancel rejects with cancelled flag', err.message);
    else fail('Cancel rejects with cancelled flag', err && err.message);
    if (err && /Could not reach the instructor hub/i.test(err.message || '')) {
      fail('Cancel does not surface hub-timeout copy', err.message);
    } else {
      pass('Cancel does not surface hub-timeout copy', err && err.message);
    }
  });
})();

// --- 2. Miner display name survives later nameless updates ---
(function () {
  const lab = new Relay('NAME');
  lab.addOrUpdateParticipant('user_fdvrks4f1', 'miner', { name: 'Miner 2', displayName: 'Miner 2' });
  lab.addOrUpdateParticipant('user_fdvrks4f1', 'miner', { hashrate: 16000, status: 'mining' });
  lab.addOrUpdateParticipant('user_fdvrks4f1', 'miner', { name: null, displayName: null });
  const p = lab.participants.get('user_fdvrks4f1');
  if (p && (p.displayName === 'Miner 2' || p.name === 'Miner 2')) {
    pass('Miner name survives nameless hashrate/join updates', p.displayName + '/' + p.name);
  } else {
    fail('Miner name survives nameless hashrate/join updates', p ? JSON.stringify(p) : 'missing');
  }

  lab.addOrUpdateParticipant('user_wallet1', 'wallet', { endowment: 100 });
  lab.addOrUpdateParticipant('user_wallet1', 'wallet', { name: 'Wallet 1', displayName: 'Wallet 1' });
  const w = lab.participants.get('user_wallet1');
  if (w && w.displayName === 'Wallet 1') pass('Wallet name still applies', w.displayName);
  else fail('Wallet name still applies', w ? JSON.stringify(w) : 'missing');
})();

// --- 3. Pause zeros hashrate ---
(function () {
  const lab = new Relay('PAUSE');
  lab.addOrUpdateParticipant('admin-1', 'admin', { displayName: 'Admin (Hub)' });
  lab.addOrUpdateParticipant('miner-1', 'miner', { name: 'Miner 2' });
  lab.updateHashrate('miner-1', 16000);
  if (lab.networkStats.totalHashrate === 16000) pass('Hashrate accumulates while live', '16000');
  else fail('Hashrate accumulates while live', String(lab.networkStats.totalHashrate));

  lab.networkPaused = true;
  lab.zeroHashratesForPause();
  if (lab.networkStats.totalHashrate === 0 && lab.participants.get('miner-1').hashrate === 0) {
    pass('Pause zeros miner + network hashrate', '0');
  } else {
    fail('Pause zeros miner + network hashrate', String(lab.networkStats.totalHashrate));
  }
  lab.updateHashrate('miner-1', 16000);
  if (lab.networkStats.totalHashrate === 0) pass('Paused hub ignores inbound hashrate', 'stays 0');
  else fail('Paused hub ignores inbound hashrate', String(lab.networkStats.totalHashrate));
})();

// --- 4. Difficulty label is readable and uses actual slider values ---
(function () {
  const a = Relay.formatDifficultyLabel(1, 8);
  const b = Relay.formatDifficultyLabel(3, 9);
  const c = Relay.formatDifficultyLabel(4, 5);
  if (a === '1 leading zero + 0x8') pass('Difficulty label 1+0x8', a);
  else fail('Difficulty label 1+0x8', a);
  if (b === '3 leading zeros + 0x9') pass('Difficulty label 3+0x9', b);
  else fail('Difficulty label 3+0x9', b);
  if (c === '4 leading zeros + 0x5') pass('Difficulty label 4+0x5', c);
  else fail('Difficulty label 4+0x5', c);
  if (/0x0\b/.test(Relay.formatDifficultyLabel(1, 0)) && !/now 1 \+ 0x0/.test(Relay.formatDifficultyLabel(1, 0))) {
    pass('Create-time 1+0x0 is spelled out, not “now 1 + 0x0”', Relay.formatDifficultyLabel(1, 0));
  } else {
    fail('Create-time 1+0x0 is spelled out', Relay.formatDifficultyLabel(1, 0));
  }
})();

// --- 5. Empty join code is an in-app message (landing source + pug) ---
(function () {
  const landing = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/lab/landing.js'), 'utf8');
  const indexPug = fs.readFileSync(path.join(__dirname, '..', 'views/lab/index.pug'), 'utf8');
  const btcPug = fs.readFileSync(path.join(__dirname, '..', 'views/lab/bitcoin.pug'), 'utf8');
  if (/Enter the session code from your instructor/.test(landing)) {
    pass('Landing has styled empty-code message', '');
  } else {
    fail('Landing has styled empty-code message', 'missing copy');
  }
  if (!/joinCode.*required/.test(indexPug) && !/required, maxlength="6"/.test(indexPug)) {
    pass('Classic landing input is not HTML-required', '');
  } else {
    fail('Classic landing input is not HTML-required', 'still required');
  }
  if (!/required, maxlength="6"/.test(btcPug)) {
    pass('Bitcoin landing input is not HTML-required', '');
  } else {
    fail('Bitcoin landing input is not HTML-required', 'still required');
  }
  if (/abortJoinProbe/.test(landing) && /err\.cancelled/.test(landing) && /joinAttempt = null/.test(landing) === false) {
    pass('Cancel keeps joinAttempt so probe abort is honored', '');
  } else {
    fail('Cancel keeps joinAttempt so probe abort is honored', 'landing.js missing abort wiring');
  }
})();

// --- 6. Admin hub live-node / pause / share-link source checks ---
(function () {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/lab/admin.js'), 'utf8');
  const adminPug = fs.readFileSync(path.join(__dirname, '..', 'views/lab/admin.pug'), 'utf8');
  if (/Live nodes:/.test(admin) && /Includes this hub/.test(admin)) {
    pass('Peers badge uses live-node copy', '');
  } else {
    fail('Peers badge uses live-node copy', 'missing Live nodes label');
  }
  if (/networkPausedBadge/.test(admin) && /Network paused/.test(admin)) {
    pass('Durable Network paused badge is wired', '');
  } else {
    fail('Durable Network paused badge is wired', 'missing badge');
  }
  if (/textarea\.form-control#joinShareLink/.test(adminPug)) {
    pass('Share link is a wrapping textarea', '');
  } else {
    fail('Share link is a wrapping textarea', 'still a single-line input');
  }
  if (/applyInboundDisplayName/.test(admin) && /hashrate-update/.test(admin)) {
    pass('Hub applies names from hashrate + presence', '');
  } else {
    fail('Hub applies names from hashrate + presence', 'missing applyInboundDisplayName');
  }
})();

Promise.resolve().then(function () {
  return new Promise(function (resolve) { setTimeout(resolve, 50); });
}).then(function () {
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n==== pass1-live-fix-test: ' + (results.length - failed) + '/' + results.length + ' passed ====');
  process.exit(failed ? 1 : 0);
});
