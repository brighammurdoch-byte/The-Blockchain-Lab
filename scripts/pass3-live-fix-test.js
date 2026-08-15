/**
 * Headless checks for Pass 3 live-QA leftovers:
 * wallet overview height, auto-difficulty snap, Create Session restore,
 * 51% hashrate gate, phone name restore.
 * Usage: node scripts/pass3-live-fix-test.js
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
    Math: Math,
    URL: URL
  };
  ctx.global = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { LabPaths: ctx.LabPaths || ctx.window.LabPaths, store: store };
}

function loadPersistence() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public/javascripts/network/Persistence.js'),
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
    }
  };
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { Persistence: ctx.window.Persistence, store: store };
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

// --- 1. Overview height never starts at 0 when the copy already has blocks ---
(function () {
  const chain = chainTo(17);
  const h = Relay.resolveOverviewHeight(chain, { networkStats: { blockHeight: 0 } }, null);
  if (h === 17) pass('Overview uses copy tip when networkStats is 0', String(h));
  else fail('Overview uses copy tip when networkStats is 0', String(h));
})();

// --- 2. Stale networkStats cannot roll Overview backward ---
(function () {
  const chain = chainTo(38);
  const h = Relay.resolveOverviewHeight(chain, {
    networkStats: { blockHeight: 22 },
    tipIndex: 22,
    hubHeight: 22
  }, 28);
  if (h === 38) pass('Overview stays at copy tip 38 (not stale 22)', String(h));
  else fail('Overview stays at copy tip 38 (not stale 22)', String(h));
})();

// --- 3. Truncated window still reports hub tip ---
(function () {
  const suffix = chainTo(38).slice(-20);
  const h = Relay.resolveOverviewHeight(suffix, { tipIndex: 38, networkStats: { blockHeight: 28 } }, 28);
  if (h === 38) pass('Overview uses hub tip on truncated window', String(h));
  else fail('Overview uses hub tip on truncated window', String(h));
})();

// --- 3b. CVV1U8: last-20 window must not leave Overview ~20 behind the panel ---
(function () {
  const pairs = [
    [22, 45],
    [28, 46],
    [28, 51],
    [31, 51]
  ];
  let ok = true;
  const details = [];
  pairs.forEach(function (pair) {
    const stale = pair[0];
    const tip = pair[1];
    const suffix = chainTo(tip).slice(-20);
    const h = Relay.resolveOverviewHeight(suffix, {
      networkStats: { blockHeight: stale },
      tipIndex: suffix.length - 1,
      hubHeight: stale
    }, stale);
    details.push(stale + '→' + tip + ' got ' + h);
    if (h !== tip) ok = false;
  });
  if (ok) pass('CVV1U8 wallet pairs converge to copy tip (not length-1)', details.join('; '));
  else fail('CVV1U8 wallet pairs converge to copy tip (not length-1)', details.join('; '));
})();

// --- 4. 101s stall interval is capped; median does not snap ---
(function () {
  const lab = new Relay('PACE');
  lab.updateSettings({ autoDifficulty: true, targetBlockTimeSec: 10, difficultyLeading: 4, difficultySecondary: 1 });
  lab.ensureGenesis();
  const capped = lab._capIntervalMs(101000);
  if (capped <= 25000 && capped >= 20000) pass('101s interval is capped at 2.5× target', capped + 'ms');
  else fail('101s interval is capped at 2.5× target', String(capped));

  lab.networkStats.blockIntervals = [100, 100, 100, 101000].map(function (ms) { return lab._capIntervalMs(ms); });
  lab.networkStats.averageBlockTimeMs = lab._medianMs(lab.networkStats.blockIntervals);
  const med = lab.networkStats.averageBlockTimeMs;
  if (med <= 25000 && med >= 250) pass('Median after 101s sample stays bounded', med + 'ms');
  else fail('Median after 101s sample stays bounded', String(med));
})();

// --- 5. Stall-ease does not dump difficulty after a too-fast burst ---
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
  if (!eased) pass('Stall-ease skipped when recent blocks were too fast', '');
  else fail('Stall-ease skipped when recent blocks were too fast',
    eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
})();

// --- 6. observedPaceMs does not keep advertising 0.1s while height is frozen ---
(function () {
  const lab = new Relay('PACEUI');
  lab.updateSettings({ autoDifficulty: true, targetBlockTimeSec: 10 });
  lab.networkStats.blockIntervals = [100, 100, 100];
  lab.networkStats.averageBlockTimeMs = 100;
  lab.networkStats.lastBlockTime = Date.now() - 45000;
  const pace = lab.observedPaceMs();
  if (pace >= 40000) pass('Frozen tip reports wait, not stale 0.1s', pace + 'ms');
  else fail('Frozen tip reports wait, not stale 0.1s', String(pace));
})();

// --- 7. Collusion team hashrate gate ---
(function () {
  const idle = Relay.collusionTeamHashrate([
    { userId: 'm1', role: 'miner', hashrate: 0 },
    { userId: 'm2', role: 'miner', hashrate: 0 },
    { userId: 'w1', role: 'wallet', hashrate: 0 }
  ]);
  if (idle.n === 2 && idle.totalHr === 0) pass('Idle miners have 0 collusion hashrate', '');
  else fail('Idle miners have 0 collusion hashrate', JSON.stringify(idle));

  const equal3 = Relay.collusionTeamHashrate([
    { userId: 'm1', role: 'miner', hashrate: 20000 },
    { userId: 'm2', role: 'miner', hashrate: 20000 },
    { userId: 'm3', role: 'miner', hashrate: 20000 }
  ]);
  if (equal3.share > 0.5 && equal3.teamN === 2) {
    pass('3 equal miners: stronger half is >50%', (equal3.share * 100).toFixed(0) + '%');
  } else {
    fail('3 equal miners: stronger half is >50%', JSON.stringify(equal3));
  }

  const minority = Relay.collusionTeamHashrate([
    { userId: 'm1', role: 'miner', hashrate: 10000 },
    { userId: 'm2', role: 'miner', hashrate: 10000 },
    { userId: 'm3', role: 'miner', hashrate: 80000 }
  ]);
  // stronger half = 2 miners: 80k + 10k = 90k / 100k = 90%
  if (minority.share > 0.5) pass('Stronger half includes the 80kH miner', (minority.share * 100).toFixed(0) + '%');
  else fail('Stronger half includes the 80kH miner', JSON.stringify(minority));
})();

// --- 8. Create Session does not restore leftover Persistence ---
(function () {
  const { Persistence, store } = loadPersistence();
  store.local['blockchain-lab-admin-91G5M2'] = JSON.stringify({ chain: [{ index: 0 }] });
  Persistence.markFreshAdminCreate('91G5M2');
  if (!store.local['blockchain-lab-admin-91G5M2'] && store.session['labAdminFreshCreate_91G5M2'] === '1') {
    pass('Fresh Create clears leftover admin state and sets tab flag', '');
  } else {
    fail('Fresh Create clears leftover admin state and sets tab flag',
      'local=' + store.local['blockchain-lab-admin-91G5M2'] + ' flag=' + store.session['labAdminFreshCreate_91G5M2']);
  }
  if (Persistence.shouldRestoreAdminState('91G5M2') === false) {
    pass('shouldRestore is false while fresh-create flag is set', '');
  } else {
    fail('shouldRestore is false while fresh-create flag is set', 'allowed restore');
  }
  const wasFresh = Persistence.consumeFreshAdminCreate('91G5M2');
  if (wasFresh && Persistence.shouldRestoreAdminState('91G5M2') === true) {
    pass('After consume, a later refresh of the same tab may restore', '');
  } else {
    fail('After consume, a later refresh of the same tab may restore',
      'wasFresh=' + wasFresh + ' should=' + Persistence.shouldRestoreAdminState('91G5M2'));
  }
})();

// --- 9. Source checks ---
(function () {
  const observe = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/lab/observe.js'), 'utf8');
  const participate = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/lab/participate.js'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/lab/admin.js'), 'utf8');
  const landing = fs.readFileSync(path.join(__dirname, '..', 'public/javascripts/lab/landing.js'), 'utf8');
  const pugAdmin = fs.readFileSync(path.join(__dirname, '..', 'views/lab/admin.pug'), 'utf8');
  const pugPart = fs.readFileSync(path.join(__dirname, '..', 'views/lab/participate.pug'), 'utf8');

  if (/resolveOverviewHeight/.test(observe) && /_observerHubHeight/.test(observe)) {
    pass('Wallet Overview uses resolveOverviewHeight', '');
  } else fail('Wallet Overview uses resolveOverviewHeight', 'missing');

  if (/restoreNodeNameInput/.test(participate) && /type="button"/.test(pugPart) === false) {
    // pug uses type="button" without escaped quotes in some styles
  }
  if (/restoreNodeNameInput/.test(participate)) {
    pass('Miner save restores #nodeName after persist', '');
  } else fail('Miner save restores #nodeName after persist', 'missing');

  if (/type="button"/.test(pugPart) || /type='button'/.test(pugPart)) {
    pass('Phone Save Node Name is type=button', '');
  } else fail('Phone Save Node Name is type=button', 'missing');

  if (/markFreshAdminCreate/.test(landing) && /consumeFreshAdminCreate/.test(admin)) {
    pass('Create Session marks a fresh admin create', '');
  } else fail('Create Session marks a fresh admin create', 'missing');

  if (/collusionTeamHashrate/.test(admin) && /more than 50%/.test(admin) && /siblings\('p, small'\)/.test(admin)) {
    pass('51% button checks hashrate and strips leftover helper', '');
  } else fail('51% button checks hashrate and strips leftover helper', 'missing');

  if (!/Only enabled if attacker has 51% hashrate/.test(pugAdmin)) {
    pass('Legacy 51% helper text removed from admin.pug', '');
  } else fail('Legacy 51% helper text removed from admin.pug', 'still present');

  const observePug = fs.readFileSync(path.join(__dirname, '..', 'views/lab/observe.pug'), 'utf8');
  const indexPug = fs.readFileSync(path.join(__dirname, '..', 'views/lab/index.pug'), 'utf8');
  if (/observe\.js\?v=p[34]fix\d+/.test(observePug) &&
      /labPaths\.js\?v=p2fix6/.test(observePug) &&
      /landing\.js\?v=p2fix4/.test(indexPug)) {
    pass('Changed scripts cache-bust past p2fix3', '');
  } else fail('Changed scripts cache-bust past p2fix3', 'stale ?v=');

  if (/mint:\s*false/.test(observe) && /pinUidInLocation/.test(observe) && /labUrl\('index'/.test(observe)) {
    pass('observe.html without uid redirects to landing (does not mint)', '');
  } else fail('observe.html without uid redirects to landing (does not mint)', 'missing mint:false / pin / landing redirect');

  if (/mintJoinUserId/.test(landing)) {
    pass('Landing Join still mints a new classroom id', '');
  } else fail('Landing Join still mints a new classroom id', 'missing mintJoinUserId');

  const paths = loadLabPaths();
  const minted = paths.LabPaths.allocateTabUserId('CVV1U8', 'wallet', { mint: false });
  if (!minted) pass('observe allocateTabUserId(mint:false) does not create a student', '');
  else fail('observe allocateTabUserId(mint:false) does not create a student', minted);
  const kept = paths.LabPaths.allocateTabUserId('CVV1U8', 'wallet', { uid: 'user_iu5u4pz0i', mint: false });
  const again = paths.LabPaths.allocateTabUserId('CVV1U8', 'wallet', { mint: false });
  if (kept === 'user_iu5u4pz0i' && again === 'user_iu5u4pz0i') {
    pass('Refresh of an observe tab keeps the pinned uid', again);
  } else fail('Refresh of an observe tab keeps the pinned uid', kept + ' / ' + again);

  const theme = fs.readFileSync(path.join(__dirname, '..', 'public/stylesheets/lab-theme.css'), 'utf8');
  if (/participant-row-actions/.test(participate) && /participant-row-actions/.test(theme) && /gap:\s*8px/.test(theme)) {
    pass('Copy and Send to have an 8px gap on phone roster rows', '');
  } else fail('Copy and Send to have an 8px gap on phone roster rows', 'missing class/gap');
})();

const failed = results.filter((r) => !r.ok).length;
console.log('\n==== pass3-live-fix-test: ' + (results.length - failed) + '/' + results.length + ' passed ====');
process.exit(failed ? 1 : 0);
