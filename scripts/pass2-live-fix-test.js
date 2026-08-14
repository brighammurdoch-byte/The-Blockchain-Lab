/**
 * Headless checks for Pass 2 live-classroom leftovers:
 * hub-canonical student copies, stale-node prune, per-tab wallet ids, toast queue.
 * Usage: node scripts/pass2-live-fix-test.js
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

function loadLabPaths() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public/javascripts/lab/labPaths.js'),
    'utf8'
  );
  const store = { local: {}, session: {} };
  const ctx = {
    window: {},
    console,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store.local, k) ? store.local[k] : null),
      setItem: (k, v) => { store.local[k] = String(v); },
      removeItem: (k) => { delete store.local[k]; }
    },
    sessionStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store.session, k) ? store.session[k] : null),
      setItem: (k, v) => { store.session[k] = String(v); },
      removeItem: (k) => { delete store.session[k]; }
    },
    Math: Math
  };
  ctx.global = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { LabPaths: ctx.LabPaths || ctx.window.LabPaths, store: store };
}

function block(index, hash, prev) {
  return {
    index: index,
    hash: hash,
    previousHash: prev || (index === 0 ? '0' : 'h' + (index - 1)),
    miner: index === 0 ? 'genesis' : 'miner-1',
    timestamp: 1000 + index,
    nonce: index,
    transactions: []
  };
}

function chainTo(n) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push(block(i, 'h' + i, i === 0 ? '0' : 'h' + (i - 1)));
  return out;
}

const Relay = loadRelay();

// --- 1. Truncated hub snapshot must not replace a longer genesis-rooted copy ---
(function () {
  const local = chainTo(80);
  const suffix = chainTo(86).slice(-20); // indices 67-86, overlaps local
  const merged = Relay.mergeCanonicalCopy(local, suffix, {
    truncated: true,
    tipHash: 'h86',
    tipIndex: 86
  });
  const tip = merged.chain[merged.chain.length - 1];
  const first = merged.chain[0];
  if (first && first.index === 0 && tip && tip.hash === 'h86' && merged.chain.length === 87) {
    pass('Splices truncated hub suffix onto local genesis copy', 'len ' + merged.chain.length);
  } else {
    fail('Splices truncated hub suffix onto local genesis copy',
      'len=' + merged.chain.length + ' first=' + (first && first.index) + ' tip=' + (tip && tip.hash) + ' reason=' + merged.reason);
  }

  const behind = chainTo(51);
  const aheadWindow = chainTo(86).slice(-20);
  const gap = Relay.mergeCanonicalCopy(behind, aheadWindow, {
    truncated: true,
    tipHash: 'h86',
    tipIndex: 86
  });
  const gapTip = gap.chain[gap.chain.length - 1];
  if (gapTip && gapTip.hash === 'h86' && Relay.canonicalCopyHeight(gap.chain, { tipIndex: 86 }) === 86) {
    pass('Disconnected newer hub window is adopted (height stays hub tip)', gap.reason);
  } else {
    fail('Disconnected newer hub window is adopted (height stays hub tip)',
      'tip=' + (gapTip && gapTip.hash) + ' reason=' + gap.reason);
  }
})();

// --- 2. Stale compact snapshot must not roll height backward ---
(function () {
  const local = chainTo(51);
  const stale = chainTo(37).slice(-20);
  const merged = Relay.mergeCanonicalCopy(local, stale, {
    truncated: true,
    tipHash: 'h37',
    tipIndex: 37
  });
  const tip = merged.chain[merged.chain.length - 1];
  if (tip && tip.hash === 'h51' && merged.chain.length === 52 && merged.applied === false) {
    pass('Rejects stale truncated snapshot (51 stays 51)', merged.reason);
  } else {
    fail('Rejects stale truncated snapshot (51 stays 51)',
      'len=' + merged.chain.length + ' tip=' + (tip && tip.hash) + ' applied=' + merged.applied + ' ' + merged.reason);
  }
})();

// --- 3. Same hub tip keeps prefix (does not shrink to last-20) ---
(function () {
  const local = chainTo(86);
  const suffix = chainTo(86).slice(-20);
  const merged = Relay.mergeCanonicalCopy(local, suffix, {
    truncated: true,
    tipHash: 'h86',
    tipIndex: 86
  });
  if (merged.chain.length === 87 && merged.chain[0].index === 0 && merged.reason === 'same-tip') {
    pass('Same-tip compact snapshot keeps full local prefix', 'len ' + merged.chain.length);
  } else {
    fail('Same-tip compact snapshot keeps full local prefix',
      'len=' + merged.chain.length + ' reason=' + merged.reason);
  }
})();

// --- 4. Display height uses tip index, not suffix length-1 ---
(function () {
  const suffix = chainTo(86).slice(-20);
  const h = Relay.canonicalCopyHeight(suffix, { tipIndex: 86, truncated: true });
  if (h === 86) pass('canonicalCopyHeight uses hub tip index', String(h));
  else fail('canonicalCopyHeight uses hub tip index', String(h));
  const raw = Relay.canonicalCopyHeight(suffix, {});
  if (raw === 86) pass('canonicalCopyHeight falls back to last block.index', String(raw));
  else fail('canonicalCopyHeight falls back to last block.index', String(raw));
})();

// --- 5. Private optimistic tail is trimmed to the hub tip ---
(function () {
  const local = chainTo(51).concat([block(52, 'private52', 'h51')]);
  const merged = Relay.mergeCanonicalCopy(local, [block(51, 'h51', 'h50')], {
    truncated: true,
    tipHash: 'h51',
    tipIndex: 51
  });
  const tip = merged.chain[merged.chain.length - 1];
  if (tip && tip.hash === 'h51' && merged.chain.length === 52) {
    pass('Trims private optimistic tail to hub tip', merged.reason);
  } else {
    fail('Trims private optimistic tail to hub tip',
      'len=' + merged.chain.length + ' tip=' + (tip && tip.hash) + ' ' + merged.reason);
  }
})();

// --- 6. Gone miner with frozen hashrate is dropped ---
(function () {
  const lab = new Relay('STALE');
  lab.addOrUpdateParticipant('admin-1', 'admin', { displayName: 'Admin (Hub)' });
  lab.addOrUpdateParticipant('user_nn9y0ppqq', 'miner', { name: 'Phone Miner' });
  lab.updateHashrate('user_nn9y0ppqq', 8797);
  const phone = lab.participants.get('user_nn9y0ppqq');
  phone.lastSeenAt = Date.now() - 40000;
  const dropped = lab.pruneStaleParticipants(['admin-1'], Date.now());
  if (dropped === 1 && !lab.participants.has('user_nn9y0ppqq')) {
    pass('Prune drops gone miner even with frozen hashrate', 'dropped ' + dropped);
  } else {
    fail('Prune drops gone miner even with frozen hashrate',
      'dropped=' + dropped + ' still=' + lab.participants.has('user_nn9y0ppqq'));
  }
})();

// --- 7. Hashrate zeros before drop; live peer is kept ---
(function () {
  const lab = new Relay('STALE2');
  lab.addOrUpdateParticipant('admin-1', 'admin');
  lab.addOrUpdateParticipant('miner-live', 'miner', { name: 'Miner 1' });
  lab.updateHashrate('miner-live', 50000);
  lab.addOrUpdateParticipant('miner-gone', 'miner', { name: 'Miner 2' });
  lab.updateHashrate('miner-gone', 8000);
  lab.participants.get('miner-gone').lastSeenAt = Date.now() - 18000;
  lab.pruneStaleParticipants(['admin-1', 'miner-live'], Date.now());
  const gone = lab.participants.get('miner-gone');
  const live = lab.participants.get('miner-live');
  if (gone && gone.hashrate === 0 && live && live.hashrate === 50000) {
    pass('Stale hashrate zeros at 15s; live miner kept', '');
  } else {
    fail('Stale hashrate zeros at 15s; live miner kept',
      'goneHr=' + (gone && gone.hashrate) + ' liveHr=' + (live && live.hashrate));
  }
})();

// --- 8. Resume clock prevents immediate stall-ease toast ---
(function () {
  const lab = new Relay('RESUME');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: 5,
    difficultySecondary: 0
  });
  lab.networkStats.totalHashrate = 80000;
  lab.networkStats.lastBlockTime = Date.now() - 60000;
  lab.noteNetworkResumed();
  const eased = lab.maybeEaseDifficultyIfStalled();
  if (!eased) pass('Resume resets stall clock (no instant difficulty ease)', '');
  else fail('Resume resets stall clock (no instant difficulty ease)', JSON.stringify(eased));
})();

// --- 9a. L3T0NE repro: later join/name on the same id must not rename Wallet 1 ---
(function () {
  const lab = new Relay('L3T0NE');
  lab.addOrUpdateParticipant('user_jpo9nfhqt', 'wallet', {
    name: 'Wallet 1',
    displayName: 'Wallet 1',
    endowment: 100
  });
  // Later tab join / hello / hashrate with the stolen id
  lab.addOrUpdateParticipant('user_jpo9nfhqt', 'wallet', {
    name: 'Wallet 2',
    displayName: 'Wallet 2'
  });
  const w = lab.participants.get('user_jpo9nfhqt');
  if (w && w.displayName === 'Wallet 1' && w.name === 'Wallet 1') {
    pass('Later join does not overwrite Wallet 1 name on same id', w.displayName);
  } else {
    fail('Later join does not overwrite Wallet 1 name on same id', w ? w.displayName : 'missing');
  }
  // Explicit Save Name from the owner is still allowed
  lab.addOrUpdateParticipant('user_jpo9nfhqt', 'wallet', {
    name: 'Wallet 1b',
    displayName: 'Wallet 1b',
    rename: true
  });
  const w2 = lab.participants.get('user_jpo9nfhqt');
  if (w2 && w2.displayName === 'Wallet 1b') {
    pass('Explicit Save Name can still rename that wallet', w2.displayName);
  } else {
    fail('Explicit Save Name can still rename that wallet', w2 ? w2.displayName : 'missing');
  }
})();

// --- 9. Two tab joins get two wallet ids ---
(function () {
  const a = loadLabPaths();
  const id1 = a.LabPaths.allocateTabUserId('L3T0NE', 'wallet');
  // Simulate a second tab: empty sessionStorage, leftover localStorage from tab 1
  const bSrc = fs.readFileSync(
    path.join(__dirname, '..', 'public/javascripts/lab/labPaths.js'),
    'utf8'
  );
  const storeB = { local: Object.assign({}, a.store.local), session: {} };
  const ctxB = {
    window: {},
    console,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(storeB.local, k) ? storeB.local[k] : null),
      setItem: (k, v) => { storeB.local[k] = String(v); }
    },
    sessionStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(storeB.session, k) ? storeB.session[k] : null),
      setItem: (k, v) => { storeB.session[k] = String(v); }
    },
    Math: Math
  };
  ctxB.global = ctxB;
  ctxB.window = ctxB;
  vm.createContext(ctxB);
  vm.runInContext(bSrc, ctxB);
  const id2 = ctxB.LabPaths.allocateTabUserId('L3T0NE', 'wallet');
  if (id1 && id2 && id1 !== id2) pass('Second tab wallet gets a new userId', id1 + ' vs ' + id2);
  else fail('Second tab wallet gets a new userId', id1 + ' vs ' + id2);

  const id1b = a.LabPaths.allocateTabUserId('L3T0NE', 'wallet');
  if (id1b === id1) pass('Same tab refresh keeps wallet id', id1b);
  else fail('Same tab refresh keeps wallet id', id1 + ' → ' + id1b);
})();

// --- 9b. L3T0NE second Join on same origin: leftover localStorage must be ignored ---
(function () {
  const leftover = loadLabPaths();
  leftover.store.local['userId_L3T0NE_wallet'] = 'user_jpo9nfhqt';
  leftover.store.local['userId_L3T0NE'] = 'user_jpo9nfhqt';
  leftover.store.local['userRole_L3T0NE'] = 'wallet';
  leftover.store.local['userRole_L3T0NE_user_jpo9nfhqt'] = 'wallet';
  leftover.store.local['nodeName_L3T0NE_user_jpo9nfhqt'] = 'Wallet 1';
  Object.keys(leftover.store.session).forEach(function (k) { delete leftover.store.session[k]; });
  if (typeof leftover.LabPaths.mintJoinUserId !== 'function') {
    fail('Landing mintJoinUserId exists', 'missing');
    return;
  }
  const minted = leftover.LabPaths.mintJoinUserId('L3T0NE', 'wallet');
  if (minted && minted !== 'user_jpo9nfhqt') {
    pass('Second landing Join mints a new id despite persisted Wallet 1', minted);
  } else {
    fail('Second landing Join mints a new id despite persisted Wallet 1', String(minted));
  }
  if (leftover.store.local['userId_L3T0NE_wallet'] === 'user_jpo9nfhqt') {
    pass('Shared userId_SESSION_wallet key is not overwritten by the new join', '');
  } else {
    fail('Shared userId_SESSION_wallet key is not overwritten by the new join',
      String(leftover.store.local['userId_L3T0NE_wallet']));
  }
  const url = leftover.LabPaths.labUrl('observe', 'L3T0NE', { uid: minted });
  if (url && /uid=/.test(url) && url.indexOf(minted) >= 0) {
    pass('Observe URL carries the minted uid', url);
  } else {
    fail('Observe URL carries the minted uid', url);
  }
})();

// --- 10. Source checks: toast queue + no localStorage wallet reuse on landing ---
(function () {
  const landing = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/lab/landing.js'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/lab/admin.js'), 'utf8');
  const participate = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/lab/participate.js'), 'utf8');
  const observe = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/lab/observe.js'), 'utf8');
  if (/mintJoinUserId/.test(landing) && /uid/.test(landing) && !/existingGeneric/.test(landing)) {
    pass('Landing mints a fresh id and passes uid= on Join', '');
  } else {
    fail('Landing mints a fresh id and passes uid= on Join', 'missing mint/uid');
  }
  if (/drainToastQueue/.test(admin) && /unshift/.test(admin) && /resumed/i.test(admin)) {
    pass('Admin toasts are queued; resume is prioritized', '');
  } else {
    fail('Admin toasts are queued; resume is prioritized', 'missing queue');
  }
  if (/drainToastQueue/.test(participate) && /6500/.test(participate)) {
    pass('Miner resume toast is queued and held', '');
  } else {
    fail('Miner resume toast is queued and held', 'missing queue/hold');
  }
  if (/allocateTabUserId/.test(observe) && /adoptObserverHubChain/.test(observe) && /orphans: \[\]/.test(observe)) {
    pass('Wallet uses per-tab id and hub-only canonical copy', '');
  } else {
    fail('Wallet uses per-tab id and hub-only canonical copy', 'missing adopt/hide orphans');
  }
  if (/persistLocalWalletName/.test(observe) && /loadLocalWalletName/.test(observe) && /rename: true/.test(admin)) {
    pass('Wallet 1 pins its own name; hub rename requires Save Name', '');
  } else {
    fail('Wallet 1 pins its own name; hub rename requires Save Name', 'missing pin/rename gate');
  }
  if (/getLivePeerIds/.test(admin) && /peer-left/.test(admin)) {
    pass('Hub prunes by fresh presence and handles peer-left', '');
  } else {
    fail('Hub prunes by fresh presence and handles peer-left', 'missing live-id filter');
  }
})();

const failed = results.filter((r) => !r.ok).length;
console.log('\n==== pass2-live-fix-test: ' + (results.length - failed) + '/' + results.length + ' passed ====');
process.exit(failed ? 1 : 0);
