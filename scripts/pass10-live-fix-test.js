/**
 * Headless checks for Pass 10 live-QA leftover (session ST0R8T / p4fix6):
 * admin.html without session must not mint a room; stall-ease must not
 * drop 3→1 in 22s; Since Last Block clock keeps incrementing; join paints
 * stay windowed off the toast turn.
 * Usage: node scripts/pass10-live-fix-test.js
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

function loadAdminShouldHost() {
  const src = loadFile('public/javascripts/lab/admin.js');
  const start = src.indexOf('function adminShouldHostSession');
  const end = src.indexOf('function formatDifficultyLabel');
  if (start < 0 || end < 0) return null;
  const snippet = src.slice(start, end);
  const ctx = {
    window: {},
    LabPaths: {
      isSessionCode: function (value) {
        var s = String(value || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,8}$/.test(s)) return false;
        return s !== 'ADMIN' && s !== 'INDEX' && s !== 'LAB';
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(snippet + '\nthis.adminShouldHostSession = adminShouldHostSession;', ctx);
  return ctx.adminShouldHostSession;
}

const Relay = loadRelay();

function classroomLab(leading, secondary) {
  const lab = new Relay('ST0R8T');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: leading,
    difficultySecondary: secondary
  });
  lab.networkStats.totalHashrate = 80000;
  lab.chain = [{ index: 139, hash: 'tip139', previousHash: '0', miner: 'user_m1' }];
  lab.networkStats.blockHeight = 139;
  return lab;
}

function armFreeze(lab, agoMs) {
  const t = Date.now() - agoMs;
  lab.networkStats.lastBlockTime = t;
  lab.networkStats._lastTipWallClock = t;
  lab.networkStats._stallWatchHeight = 139;
  lab.networkStats._stallWatchAt = t;
}

// --- 1. admin.html without session does not create ---
(function () {
  const fn = loadAdminShouldHost();
  const admin = loadFile('public/javascripts/lab/admin.js');
  const gated = fn
    && fn('') === false
    && fn(null) === false
    && fn('ADMIN') === false
    && fn('ST0R8T') === true
    && /must NOT mint a classroom/.test(admin)
    && /location\.replace/.test(admin)
    && /adminShouldHostSession\(sessionId\)/.test(admin);
  if (gated) pass('admin.html without session does not create a room', '');
  else fail('admin.html without session does not create a room',
    fn ? JSON.stringify({ empty: fn(''), admin: fn('ADMIN'), ok: fn('ST0R8T') }) : 'missing helper');
})();

// --- 2. Stall clock keeps incrementing while tip is frozen ---
(function () {
  const lab = classroomLab(3, 10);
  const t0 = Date.now();
  lab.networkStats.lastBlockTime = t0 - 31000;
  lab.networkStats._lastTipWallClock = t0 - 31000;
  const a = lab.sinceLastBlockMs(t0);
  const b = lab.sinceLastBlockMs(t0 + 20000);
  if (a >= 30000 && a <= 32000 && b >= 50000 && b <= 52000 && b > a) {
    pass('Stall clock keeps incrementing on the wall clock',
      Math.floor(a / 1000) + 's → ' + Math.floor(b / 1000) + 's');
  } else {
    fail('Stall clock keeps incrementing on the wall clock',
      JSON.stringify({ a: a, b: b }));
  }
})();

// --- 3. Height change resets the freeze clock ---
(function () {
  const lab = classroomLab(3, 10);
  const t0 = Date.now();
  lab.networkStats.lastBlockTime = t0 - 80000;
  lab.networkStats._lastTipWallClock = t0 - 80000;
  lab.networkStats._stallWatchHeight = 139;
  lab.networkStats._stallWatchAt = t0 - 80000;
  lab.chain = [{ index: 140, hash: 'tip140', previousHash: 'tip139', miner: 'user_m1' }];
  lab.networkStats.blockHeight = 140;
  lab._syncStallWatch(140);
  const ms = lab.sinceLastBlockMs(Date.now());
  if (ms < 2000) pass('Height change resets the freeze clock', ms + 'ms');
  else fail('Height change resets the freeze clock', String(ms));
})();

// --- 4. No 3→1 zero-drop in 22s ---
(function () {
  const lab = classroomLab(3, 10);
  armFreeze(lab, 40000);
  const first = lab.maybeEaseDifficultyIfStalled();
  const L1 = lab.settings.difficultyLeading;
  // Simulate 22s of 5s ease ticks after the first drop (nibble cooldown expired).
  if (lab.networkStats.lastRetarget) {
    lab.networkStats.lastRetarget.at = Date.now() - 6000;
  }
  if (lab.networkStats._stallZeroAt) {
    lab.networkStats._stallZeroAt = Date.now() - 22000;
  }
  if (lab.networkStats.lastRetarget) {
    lab.networkStats.lastRetarget.stallZeroAt = lab.networkStats._stallZeroAt;
  }
  armFreeze(lab, 62000);
  const second = lab.maybeEaseDifficultyIfStalled();
  const L2 = lab.settings.difficultyLeading;
  if (first && L1 === 2 && L2 === 2 && !(second && second.difficultyLeading === 1)) {
    pass('No 3→1 zero-drop in 22s', 'L=' + L2);
  } else {
    fail('No 3→1 zero-drop in 22s',
      JSON.stringify({
        first: first && (first.difficultyLeading + '+0x' + Number(first.difficultySecondary).toString(16)),
        second: second && (second.difficultyUnchanged ? 'republish' : (second.difficultyLeading + '+0x' + Number(second.difficultySecondary).toString(16))),
        L1: L1,
        L2: L2
      }));
  }
})();

// --- 5. Zero-drop cooldown: second drop needs ≥25s ---
(function () {
  const lab = classroomLab(3, 10);
  armFreeze(lab, 40000);
  lab.maybeEaseDifficultyIfStalled();
  const afterFirst = lab.settings.difficultyLeading;
  if (lab.networkStats.lastRetarget) lab.networkStats.lastRetarget.at = Date.now() - 6000;
  lab.networkStats._stallZeroAt = Date.now() - 26000;
  if (lab.networkStats.lastRetarget) {
    lab.networkStats.lastRetarget.stallZeroAt = lab.networkStats._stallZeroAt;
  }
  armFreeze(lab, 66000);
  const later = lab.maybeEaseDifficultyIfStalled();
  const L = lab.settings.difficultyLeading;
  if (afterFirst === 2 && later && L === 1) {
    pass('Zero-drop cooldown allows a second drop after ≥25s', 'L=' + L);
  } else {
    fail('Zero-drop cooldown allows a second drop after ≥25s',
      JSON.stringify({
        afterFirst: afterFirst,
        later: later && (later.difficultyUnchanged ? 'republish' : later.difficultyLeading),
        L: L
      }));
  }
})();

// --- 6. Immediate second ease still does not drop another zero (held) ---
(function () {
  const lab = classroomLab(3, 10);
  armFreeze(lab, 40000);
  const first = lab.maybeEaseDifficultyIfStalled();
  const second = lab.maybeEaseDifficultyIfStalled();
  if (first && first.difficultyLeading === 2 && !second && lab.settings.difficultyLeading === 2) {
    pass('Second stall-ease within 5s does not drop another zero', '');
  } else {
    fail('Second stall-ease within 5s does not drop another zero',
      JSON.stringify({
        first: first && first.difficultyLeading,
        second: second && (second.difficultyUnchanged || second.difficultyLeading)
      }));
  }
})();

// --- 7. 13s path still nibbles only (held) ---
(function () {
  const lab = classroomLab(3, 10);
  armFreeze(lab, 13000);
  const eased = lab.maybeEaseDifficultyIfStalled();
  if (eased && eased.difficultyLeading === 3 && Number(eased.difficultySecondary) > 10) {
    pass('13s real freeze still eases nibble only',
      eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
  } else {
    fail('13s real freeze still eases nibble only',
      eased ? (eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16)) : 'no ease');
  }
})();

// --- 8. Frozen at 1+0xF still signals tip republish ---
(function () {
  const lab = classroomLab(1, 15);
  armFreeze(lab, 40000);
  const eased = lab.maybeEaseDifficultyIfStalled();
  if (eased && eased.republishTip && eased.difficultyUnchanged && lab.settings.difficultyLeading === 1) {
    pass('1+0xF long freeze republishes tip instead of sitting silent', '');
  } else {
    fail('1+0xF long freeze republishes tip instead of sitting silent',
      JSON.stringify(eased));
  }
})();

// --- 9. Join paints are staggered off the toast turn ---
(function () {
  const admin = loadFile('public/javascripts/lab/admin.js');
  const coord = loadFile('public/javascripts/network/AdminRelayCoordinator.js');
  const joinStagger = /scheduleJoinUiPaints/.test(admin)
    && /Join toast must not rebuild/.test(admin)
    && /peer-joined[\s\S]*scheduleJoinUiPaints/.test(admin);
  const noSyncRewards = /Do not walk the whole chain here/.test(admin)
    && /Do not _recomputeMiningRewards on join/.test(coord);
  const deferred = /setTimeout\(function \(\) \{[\s\S]*initial-state/.test(coord)
    && /100\)/.test(coord);
  const clock = /refreshSinceLastBlockDisplay/.test(admin)
    && /1000\)/.test(admin);
  if (joinStagger && noSyncRewards && deferred && clock) {
    pass('Join / name paints windowed; Since Last ticks every 1s', '');
  } else {
    fail('Join / name paints windowed; Since Last ticks every 1s',
      JSON.stringify({ joinStagger: joinStagger, noSyncRewards: noSyncRewards, deferred: deferred, clock: clock }));
  }
})();

// --- 10. Cache-bust p4fix7 on every edited referenced script ---
(function () {
  const adminPug = loadFile('views/lab/admin.pug');
  const partPug = loadFile('views/lab/participate.pug');
  const obsPug = loadFile('views/lab/observe.pug');
  const indexPug = loadFile('views/lab/index.pug');
  const ok =
    /RelayBlockchainState\.js\?v=p4fix7/.test(adminPug + partPug + obsPug + indexPug) &&
    /admin\.js\?v=p4fix8/.test(adminPug) &&
    /AdminRelayCoordinator\.js\?v=p4fix7/.test(adminPug + partPug + obsPug) &&
    /networkVisualization\.js\?v=p4fix7/.test(adminPug) &&
    /Persistence\.js\?v=p4fix9/.test(adminPug + indexPug) &&
    /landing\.js\?v=p4fix9/.test(indexPug);
  if (ok) pass('Edited scripts cache-bust p4fix7', '');
  else fail('Edited scripts cache-bust p4fix7', 'stale ?v=');
})();

const failed = results.filter(function (r) { return !r.ok; });
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
