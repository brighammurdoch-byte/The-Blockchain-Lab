/**
 * Headless checks for Pass 7 live-QA leftover (session QT0G4E):
 * auto-difficulty 1→5 overshoot in ~1 minute, then 58s tip freeze.
 * Usage: node scripts/pass7-live-fix-test.js
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

const Relay = loadRelay();

function classroomLab(leading, secondary) {
  const lab = new Relay('QT0G4E');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: leading,
    difficultySecondary: secondary
  });
  lab.networkStats.totalHashrate = 55000;
  return lab;
}

function paceFast(lab) {
  lab.networkStats.blockIntervals = [300, 300, 280, 310];
  lab.networkStats.totalHashrate = 55000;
}

// --- 1. First way-too-fast step is still exactly one zero (leave 1+0x0) ---
(function () {
  const lab = classroomLab(1, 0);
  paceFast(lab);
  const s = lab.maybeRetargetDifficulty();
  if (s && s.difficultyLeading === 2 && Number(s.difficultySecondary) === 0) {
    pass('Empty-hub 1+0x0 still climbs one zero when miners appear',
      s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16));
  } else {
    fail('Empty-hub 1+0x0 still climbs one zero when miners appear',
      s ? (s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16)) : 'no change');
  }
})();

// --- 2. 5s later must NOT add another zero (the p4fix3 rocket) ---
(function () {
  const lab = classroomLab(1, 0);
  paceFast(lab);
  lab.maybeRetargetDifficulty();
  paceFast(lab);
  lab.networkStats.lastRetarget.at = Date.now() - 6000;
  const s = lab.maybeRetargetDifficulty();
  const L = lab.settings.difficultyLeading;
  if (L === 2 && !(s && s.difficultyLeading >= 3)) {
    pass('5s after 1→2 does not add 2→3',
      L + '+0x' + Number(lab.settings.difficultySecondary).toString(16));
  } else {
    fail('5s after 1→2 does not add 2→3',
      s ? (s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16)) : ('stuck L=' + L));
  }
})();

// --- 3. After 35s, 0.3s pace at 2+0x0 may add 2→3 (PR #9 path, rate-limited) ---
(function () {
  const lab = classroomLab(2, 0);
  paceFast(lab);
  lab.networkStats.lastRetarget = {
    at: Date.now() - 36000,
    leadingZeroAt: Date.now() - 36000,
    addedLeadingZero: true,
    delta: 16,
    leading: 2,
    secondary: 0
  };
  const s = lab.maybeRetargetDifficulty();
  if (s && s.difficultyLeading === 3) {
    pass('Still-too-fast after 35s adds one more zero (2→3)',
      s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16));
  } else {
    fail('Still-too-fast after 35s adds one more zero (2→3)',
      s ? (s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16)) : 'no change');
  }
})();

// --- 4. Simulated 60s of 5s ticks with 3 miners must not reach 5 zeros ---
(function () {
  const lab = classroomLab(1, 0);
  paceFast(lab);
  lab.maybeRetargetDifficulty();
  let lastZeroElapsed = 0;
  let maxL = lab.settings.difficultyLeading;
  let maxLeadJump = maxL - 1;
  for (let elapsed = 5000; elapsed <= 60000; elapsed += 5000) {
    paceFast(lab);
    if (lab.networkStats.lastRetarget) {
      lab.networkStats.lastRetarget.at = Date.now() - 6000;
      lab.networkStats.lastRetarget.leadingZeroAt = Date.now() - (elapsed - lastZeroElapsed);
    }
    const beforeL = lab.settings.difficultyLeading;
    const s = lab.maybeRetargetDifficulty();
    if (s && s.difficultyLeading > beforeL) {
      lastZeroElapsed = elapsed;
      maxLeadJump = Math.max(maxLeadJump, s.difficultyLeading - beforeL);
    }
    maxL = Math.max(maxL, lab.settings.difficultyLeading);
  }
  if (maxL <= 3 && maxLeadJump <= 1) {
    pass('60s of 3-miner 0.3s blocks stays at ≤3 zeros',
      'maxL=' + maxL + ' maxLeadJump=' + maxLeadJump);
  } else {
    fail('60s of 3-miner 0.3s blocks stays at ≤3 zeros',
      'maxL=' + maxL + ' maxLeadJump=' + maxLeadJump);
  }
})();

// --- 5. Hashrate-implied L blocks 4+0xC → 5+0xC (nibble harder instead) ---
(function () {
  const lab = classroomLab(4, 12);
  paceFast(lab);
  lab.networkStats.lastRetarget = {
    at: Date.now() - 40000,
    leadingZeroAt: Date.now() - 40000,
    addedLeadingZero: true,
    leading: 4,
    secondary: 12
  };
  const s = lab.maybeRetargetDifficulty();
  if (s && s.difficultyLeading === 4 && Number(s.difficultySecondary) < 12) {
    pass('At 4+0xC, way-too-fast tightens nibble instead of 5+0xC',
      s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16));
  } else {
    fail('At 4+0xC, way-too-fast tightens nibble instead of 5+0xC',
      s ? (s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16)) : 'no change');
  }
})();

// --- 6. One retarget still cannot jump 1→4 or 2→5 ---
(function () {
  const lab = classroomLab(2, 0);
  paceFast(lab);
  const s = lab.maybeRetargetDifficulty();
  if (s && s.difficultyLeading <= 3) {
    pass('Single retarget at 2+0x0 still max +1 leading zero',
      s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16));
  } else {
    fail('Single retarget at 2+0x0 still max +1 leading zero',
      s ? (s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16)) : 'no change');
  }
})();

// --- 7. Stall-ease at 13s with hashing miners (before a 25s freeze) ---
(function () {
  const lab = classroomLab(5, 12);
  lab.networkStats.blockIntervals = [2100, 2100, 2000];
  lab.networkStats.lastBlockTime = Date.now() - 13000;
  lab.networkStats.lastRetarget = {
    at: Date.now() - 13000,
    delta: 16,
    leading: 5,
    secondary: 12,
    addedLeadingZero: true,
    leadingZeroAt: Date.now() - 13000
  };
  const eased = lab.maybeEaseDifficultyIfStalled();
  const easier = eased && (
    eased.difficultyLeading < 5 ||
    Number(eased.difficultySecondary) > 12
  );
  if (easier) {
    pass('13s freeze at 5+0xC eases toward easier work',
      eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
  } else {
    fail('13s freeze at 5+0xC eases toward easier work',
      eased ? (eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16)) : 'no ease');
  }
})();

// --- 8. 11s freeze must not ease yet ---
(function () {
  const lab = classroomLab(5, 12);
  lab.networkStats.lastBlockTime = Date.now() - 11000;
  lab.networkStats.lastRetarget = { at: Date.now() - 11000, delta: 16, leading: 5, secondary: 12 };
  const eased = lab.maybeEaseDifficultyIfStalled();
  if (!eased) pass('11s freeze still waits (no instant collapse)', '');
  else fail('11s freeze still waits (no instant collapse)',
    eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
})();

// --- 9. Stall-ease must not tighten the nibble (the 58s C→B→1 walk) ---
(function () {
  const lab = classroomLab(5, 12);
  lab.networkStats.blockIntervals = [];
  lab.networkStats.lastBlockTime = Date.now() - 20000;
  const eased = lab.maybeEaseDifficultyIfStalled();
  if (eased && !(eased.difficultyLeading === 5 && Number(eased.difficultySecondary) < 12)) {
    pass('Stall-ease does not walk 5+0xC → 0xB (harder)',
      eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
  } else {
    fail('Stall-ease does not walk 5+0xC → 0xB (harder)',
      eased ? (eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16)) : 'no ease');
  }
})();

// --- 10. Toast still carries the measured pace, including stall freeze ---
(function () {
  const admin = loadFile('public/javascripts/lab/admin.js');
  const usesRt = /lastRt\.avgMs/.test(admin);
  const stallPace = /easing after a stall/.test(admin) && /observed/.test(admin);
  if (usesRt && stallPace) {
    pass('Retarget toast shows observed pace (including stall freeze)', '');
  } else {
    fail('Retarget toast shows observed pace (including stall freeze)',
      JSON.stringify({ usesRt: usesRt, stallPace: stallPace }));
  }
})();

// --- 11. Cache-bust p4fix4 on edited scripts ---
(function () {
  const adminPug = loadFile('views/lab/admin.pug');
  const partPug = loadFile('views/lab/participate.pug');
  const obsPug = loadFile('views/lab/observe.pug');
  const ok =
    /RelayBlockchainState\.js\?v=p4fix5/.test(adminPug + partPug + obsPug) &&
    /admin\.js\?v=p4fix5/.test(adminPug);
  if (ok) pass('Edited scripts cache-bust p4fix5', '');
  else fail('Edited scripts cache-bust p4fix5', 'stale ?v=');
})();

const failed = results.filter(function (r) { return !r.ok; });
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
