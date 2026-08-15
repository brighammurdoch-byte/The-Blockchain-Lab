/**
 * Headless checks for Pass 9 live-QA leftover (session XU1J1S / p4fix5):
 * admin join Aw Snap, mid-watch restore toast, stall-ease zero-drops
 * while the tip is still moving, stale observed-avg, phone prune.
 * Usage: node scripts/pass9-live-fix-test.js
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

function loadPersistence() {
  const src = loadFile('public/javascripts/network/Persistence.js');
  const store = {};
  const ctx = {
    window: {},
    console,
    sessionStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    localStorage: {
      getItem: function () { return null; },
      setItem: function () {},
      removeItem: function () {}
    }
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.Persistence;
}

const Relay = loadRelay();

function classroomLab(leading, secondary) {
  const lab = new Relay('XU1J1S');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: leading,
    difficultySecondary: secondary
  });
  lab.networkStats.totalHashrate = 40000;
  return lab;
}

// --- 1. Stale tip wall-clock + climbing height is not a zero-drop ---
(function () {
  const lab = classroomLab(4, 3);
  lab.networkStats.totalHashrate = 29900;
  lab.chain = [{ index: 71, hash: 'tip71', previousHash: '0', miner: 'user_m2' }];
  lab.networkStats.blockHeight = 71;
  lab.networkStats.lastBlockTime = Date.now() - 27000;
  lab.networkStats._lastTipWallClock = Date.now() - 27000;
  lab.networkStats._stallWatchHeight = 70;
  lab.networkStats._stallWatchAt = Date.now() - 27000;
  const eased = lab.maybeEaseDifficultyIfStalled();
  if (!eased) pass('Stale 27s clock + new tip height does not drop a zero', '');
  else fail('Stale 27s clock + new tip height does not drop a zero',
    eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
})();

// --- 2. Since Last Block 0s blocks a zero-drop even if tipWall is 27s ---
(function () {
  const lab = classroomLab(4, 3);
  lab.networkStats.totalHashrate = 29900;
  lab.chain = [{ index: 80, hash: 'tip80', previousHash: '0', miner: 'user_m2' }];
  lab.networkStats.blockHeight = 80;
  lab.networkStats.lastBlockTime = Date.now();
  lab.networkStats._lastTipWallClock = Date.now() - 27000;
  lab.networkStats._stallWatchHeight = 80;
  lab.networkStats._stallWatchAt = Date.now() - 27000;
  const eased = lab.maybeEaseDifficultyIfStalled();
  const dropped = eased && eased.difficultyLeading < 4;
  if (!dropped) pass('Fresh lastBlockTime blocks stall zero-drop (stale tipWall)', '');
  else fail('Fresh lastBlockTime blocks stall zero-drop (stale tipWall)',
    eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
})();

// --- 3. 12s path still nibbles only (held) ---
(function () {
  const lab = classroomLab(4, 3);
  lab.networkStats.totalHashrate = 29900;
  lab.networkStats.lastBlockTime = Date.now() - 13000;
  lab.networkStats._lastTipWallClock = Date.now() - 13000;
  const eased = lab.maybeEaseDifficultyIfStalled();
  if (eased && eased.difficultyLeading === 4 && Number(eased.difficultySecondary) > 3) {
    pass('13s real freeze still eases nibble only',
      eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
  } else {
    fail('13s real freeze still eases nibble only',
      eased ? (eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16)) : 'no ease');
  }
})();

// --- 4. True 25s freeze still drops one zero (held) ---
(function () {
  const lab = classroomLab(4, 3);
  lab.networkStats.totalHashrate = 29900;
  lab.networkStats.lastBlockTime = Date.now() - 26000;
  lab.networkStats._lastTipWallClock = Date.now() - 26000;
  lab.networkStats.lastRetarget = {
    at: Date.now() - 14000,
    stalled: true,
    avgMs: 12000,
    leading: 4,
    secondary: 3
  };
  const eased = lab.maybeEaseDifficultyIfStalled();
  if (eased && eased.difficultyLeading === 3) {
    pass('25s real freeze still drops one leading zero',
      eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
  } else {
    fail('25s real freeze still drops one leading zero',
      eased ? (eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16)) : 'no ease');
  }
})();

// --- 5. Zero-drop cooldown still blocks 4→1 burst ---
(function () {
  const lab = classroomLab(4, 3);
  lab.networkStats.totalHashrate = 29900;
  lab.networkStats.lastBlockTime = Date.now() - 40000;
  lab.networkStats._lastTipWallClock = Date.now() - 40000;
  const first = lab.maybeEaseDifficultyIfStalled();
  const second = lab.maybeEaseDifficultyIfStalled();
  const L1 = first ? first.difficultyLeading : lab.settings.difficultyLeading;
  const L2 = lab.settings.difficultyLeading;
  if (first && L1 === 3 && L2 === 3 && !second) {
    pass('Second stall-ease within 5s does not drop another zero', 'L=' + L2);
  } else {
    fail('Second stall-ease within 5s does not drop another zero',
      JSON.stringify({
        first: first && (first.difficultyLeading + '+0x' + Number(first.difficultySecondary).toString(16)),
        second: second && (second.difficultyLeading + '+0x' + Number(second.difficultySecondary).toString(16)),
        L2: L2
      }));
  }
})();

// --- 6. observedPaceMs follows a fresh tip, not a leftover 19s stall sample ---
(function () {
  const lab = classroomLab(4, 3);
  lab.networkStats.blockIntervals = [2000, 4000, 8000];
  lab.networkStats.averageBlockTimeMs = 19000;
  lab.networkStats.lastBlockTime = Date.now();
  lab.networkStats._lastTipWallClock = Date.now();
  lab.networkStats._stallWatchAt = Date.now();
  lab.networkStats.lastRetarget = { stalled: true, avgMs: 19000 };
  const pace = lab.observedPaceMs();
  if (pace > 0 && pace < 12000) {
    pass('observedPaceMs matches fresh tip (not leftover 19s stall)', (pace / 1000).toFixed(1) + 's');
  } else {
    fail('observedPaceMs matches fresh tip (not leftover 19s stall)', String(pace));
  }
})();

// --- 7. Restore toast gated: live hub / create / in-memory never toast ---
(function () {
  const P = loadPersistence();
  P.markLiveAdminHub('XU1J1S');
  const live = P.shouldToastAdminRestore('XU1J1S', {
    freshCreate: false,
    alreadyToasted: false,
    inMemoryLive: false,
    hasPersistedChain: true
  });
  const fresh = P.shouldToastAdminRestore('NEWCODE', {
    freshCreate: true,
    alreadyToasted: false,
    inMemoryLive: false,
    hasPersistedChain: true
  });
  const mem = P.shouldToastAdminRestore('OTHER', {
    freshCreate: false,
    alreadyToasted: false,
    inMemoryLive: true,
    hasPersistedChain: true
  });
  const closed = P.shouldToastAdminRestore('OLDSES', {
    freshCreate: false,
    alreadyToasted: false,
    inMemoryLive: false,
    hasPersistedChain: true
  });
  if (!live && !fresh && !mem && closed) {
    pass('Restore toast only after tab close + persisted chain', '');
  } else {
    fail('Restore toast only after tab close + persisted chain',
      JSON.stringify({ live: live, fresh: fresh, mem: mem, closed: closed }));
  }
})();

// --- 8. Join path is scheduled (no sync full chain rebuild) ---
(function () {
  const admin = loadFile('public/javascripts/lab/admin.js');
  const coord = loadFile('public/javascripts/network/AdminRelayCoordinator.js');
  const joinSched = /peer-joined[\s\S]*scheduleRenderClientRelayChain/.test(admin)
    && /Join toast must not rebuild/.test(admin);
  const nameSched = /node-name-changed[\s\S]*scheduleRenderClientRelayChain/.test(admin);
  const deferred = /setTimeout\(function \(\) \{[\s\S]*initial-state/.test(coord);
  if (joinSched && nameSched && deferred) {
    pass('Join / name / coordinator do not sync-rebuild the chain', '');
  } else {
    fail('Join / name / coordinator do not sync-rebuild the chain',
      JSON.stringify({ joinSched: joinSched, nameSched: nameSched, deferred: deferred }));
  }
})();

// --- 9. Phone miner not in presence is pruned by ~25s ---
(function () {
  const lab = new Relay('MYDFSN');
  lab.addOrUpdateParticipant('user_zzom5czfa', 'miner', { name: 'Phone Miner' });
  const p = lab.participants.get('user_zzom5czfa');
  p.lastSeenAt = Date.now() - 26000;
  p.hashrate = 0;
  p.status = 'idle';
  const n = lab.pruneStaleParticipants([]);
  if (n === 1 && !lab.participants.has('user_zzom5czfa')) {
    pass('Student absent ~25s is pruned from Live nodes', '');
  } else {
    fail('Student absent ~25s is pruned from Live nodes',
      'dropped=' + n + ' still=' + lab.participants.has('user_zzom5czfa'));
  }
})();

// --- 10. Presence keep-alive does not rewrite lastSeenAt ---
(function () {
  const lab = new Relay('MYDFSN');
  lab.addOrUpdateParticipant('user_zzom5czfa', 'miner', { name: 'Phone Miner' });
  const p = lab.participants.get('user_zzom5czfa');
  const stamped = Date.now() - 10000;
  p.lastSeenAt = stamped;
  lab.pruneStaleParticipants(['user_zzom5czfa']);
  if (p.lastSeenAt === stamped && lab.participants.has('user_zzom5czfa')) {
    pass('Live presence does not refresh lastSeenAt (prune clock stays honest)', '');
  } else {
    fail('Live presence does not refresh lastSeenAt (prune clock stays honest)',
      'lastSeenAt delta=' + (p.lastSeenAt - stamped));
  }
})();

// --- 11. Cache-bust p4fix6 on every edited referenced script ---
(function () {
  const adminPug = loadFile('views/lab/admin.pug');
  const partPug = loadFile('views/lab/participate.pug');
  const obsPug = loadFile('views/lab/observe.pug');
  const indexPug = loadFile('views/lab/index.pug');
  const ok =
    /RelayBlockchainState\.js\?v=p4fix7/.test(adminPug + partPug + obsPug + indexPug) &&
    /admin\.js\?v=p4fix8/.test(adminPug) &&
    /AdminRelayCoordinator\.js\?v=p4fix7/.test(adminPug + partPug + obsPug) &&
    /Persistence\.js\?v=p4fix9/.test(adminPug + indexPug) &&
    /landing\.js\?v=p4fix9/.test(indexPug) &&
    /observe\.js\?v=p4fix5/.test(obsPug) &&
    /NetworkManager\.js\?v=p4fix5/.test(adminPug);
  if (ok) pass('Edited scripts cache-bust p4fix7', '');
  else fail('Edited scripts cache-bust p4fix7', 'stale ?v=');
})();

const failed = results.filter(function (r) { return !r.ok; });
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
