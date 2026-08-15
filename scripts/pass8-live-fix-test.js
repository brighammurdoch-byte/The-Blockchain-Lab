/**
 * Headless checks for Pass 8 live-QA leftover (session MYDFSN / p4fix4):
 * nibble ease while blocks are still too fast, wallet name never reaches
 * the hub, restore toast on a live Create Session hub.
 * Usage: node scripts/pass8-live-fix-test.js
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
  const lab = new Relay('MYDFSN');
  lab.updateSettings({
    autoDifficulty: true,
    targetBlockTimeSec: 10,
    difficultyLeading: leading,
    difficultySecondary: secondary
  });
  lab.networkStats.totalHashrate = 40000;
  return lab;
}

// --- 1. Stale lastBlockTime + recent tip wall-clock is not a stall ---
(function () {
  const lab = classroomLab(4, 11);
  lab.networkStats.blockIntervals = [1800, 2000, 1700];
  lab.networkStats.lastBlockTime = Date.now() - 13000;
  lab.networkStats._lastTipWallClock = Date.now() - 2500;
  lab.networkStats.lastRetarget = { at: Date.now() - 13000, stalled: true, avgMs: 13000 };
  const eased = lab.maybeEaseDifficultyIfStalled();
  if (!eased) pass('Recent tip wall-clock blocks false stall-ease (13s lastBlockTime)', '');
  else fail('Recent tip wall-clock blocks false stall-ease (13s lastBlockTime)',
    eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
})();

// --- 2. lastRetarget.at 13s ago while tips still land is not a stall ---
(function () {
  const lab = classroomLab(4, 3);
  lab.networkStats.blockIntervals = [2800, 2600, 3000];
  lab.networkStats.lastBlockTime = Date.now() - 2800;
  lab.networkStats._lastTipWallClock = Date.now() - 2800;
  lab.networkStats.lastRetarget = { at: Date.now() - 13000, leading: 4, secondary: 3 };
  const eased = lab.maybeEaseDifficultyIfStalled();
  if (!eased) pass('lastRetarget.at fallback does not fire while height is climbing', '');
  else fail('lastRetarget.at fallback does not fire while height is climbing',
    eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
})();

// --- 3. 1.8s pace at capped L tightens nibble, does not ease 0xB → easier ---
(function () {
  const lab = classroomLab(4, 11);
  lab.networkStats.blockIntervals = [1800, 1800, 1700, 1900];
  lab.networkStats.totalHashrate = 40000;
  lab.networkStats.lastRetarget = {
    at: Date.now() - 6000,
    leadingZeroAt: Date.now() - 40000,
    addedLeadingZero: true,
    leading: 4,
    secondary: 11
  };
  const s = lab.maybeRetargetDifficulty();
  const tightened = s && s.difficultyLeading === 4 && Number(s.difficultySecondary) < 11;
  const eased = s && Number(s.difficultySecondary) > 11;
  if (tightened && !eased) {
    pass('1.8s at 4+0xB tightens nibble toward 0x0',
      s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16));
  } else {
    fail('1.8s at 4+0xB tightens nibble toward 0x0',
      s ? (s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16)) : 'no change');
  }
})();

// --- 4. 3.9s (not quite 3×) must not ease 0x9 → 0xB ---
(function () {
  const lab = classroomLab(4, 9);
  lab.networkStats.blockIntervals = [3900, 3800, 4000];
  lab.networkStats.totalHashrate = 40000;
  lab.networkStats.lastRetarget = {
    at: Date.now() - 6000,
    leadingZeroAt: Date.now() - 40000,
    leading: 4,
    secondary: 9
  };
  const s = lab.maybeRetargetDifficulty();
  const eased = s && Number(s.difficultySecondary) > 9;
  if (!eased) {
    pass('3.9s at 4+0x9 does not ease the nibble',
      s ? (s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16)) : 'no change');
  } else {
    fail('3.9s at 4+0x9 does not ease the nibble',
      s.difficultyLeading + '+0x' + Number(s.difficultySecondary).toString(16));
  }
})();

// --- 5. True 13s freeze with hashing miners still eases (no 25s tip freeze) ---
(function () {
  const lab = classroomLab(5, 12);
  lab.networkStats.blockIntervals = [2100, 2100, 2000];
  lab.networkStats.lastBlockTime = Date.now() - 13000;
  lab.networkStats._lastTipWallClock = Date.now() - 13000;
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
    pass('13s real freeze still eases toward easier work',
      eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
  } else {
    fail('13s real freeze still eases toward easier work',
      eased ? (eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16)) : 'no ease');
  }
})();

// --- 5b. 13s at 4+0x3 (hashrate-implied L) only eases the nibble ---
(function () {
  const lab = classroomLab(4, 3);
  lab.networkStats.totalHashrate = 29900;
  lab.networkStats.lastBlockTime = Date.now() - 13000;
  lab.networkStats._lastTipWallClock = Date.now() - 13000;
  const eased = lab.maybeEaseDifficultyIfStalled();
  if (eased && eased.difficultyLeading === 4 && Number(eased.difficultySecondary) > 3) {
    pass('13s at 4+0x3 eases nibble only (no instant 4→3)',
      eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
  } else {
    fail('13s at 4+0x3 eases nibble only (no instant 4→3)',
      eased ? (eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16)) : 'no ease');
  }
})();

// --- 5c. MYDFSN h279: 25s+ freeze at 4+0x3 / 30kH/s drops a zero ---
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
    pass('25s freeze at 4+0x3 drops a leading zero (unstick)',
      eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16));
  } else {
    fail('25s freeze at 4+0x3 drops a leading zero (unstick)',
      eased ? (eased.difficultyLeading + '+0x' + Number(eased.difficultySecondary).toString(16)) : 'no ease');
  }
})();

// --- 5d. Long-freeze zero drops are rate-limited (no 4→1 in one burst) ---
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
    pass('Second stall-ease within 5s does not drop another zero',
      'L=' + L2);
  } else {
    fail('Second stall-ease within 5s does not drop another zero',
      JSON.stringify({
        first: first && (first.difficultyLeading + '+0x' + Number(first.difficultySecondary).toString(16)),
        second: second && (second.difficultyLeading + '+0x' + Number(second.difficultySecondary).toString(16)),
        L2: L2
      }));
  }
})();

// --- 5e. After a stall zero-drop, 5s later must not add the zero back ---
(function () {
  const lab = classroomLab(4, 3);
  lab.networkStats.totalHashrate = 29900;
  lab.networkStats.lastBlockTime = Date.now() - 26000;
  lab.networkStats._lastTipWallClock = Date.now() - 26000;
  lab.maybeEaseDifficultyIfStalled();
  lab.networkStats.blockIntervals = [300, 300, 280];
  if (lab.networkStats.lastRetarget) lab.networkStats.lastRetarget.at = Date.now() - 6000;
  const back = lab.maybeRetargetDifficulty();
  const L = lab.settings.difficultyLeading;
  if (L === 3 && !(back && back.difficultyLeading >= 4)) {
    pass('Stall zero-drop is not immediately reversed by way-too-fast',
      L + '+0x' + Number(lab.settings.difficultySecondary).toString(16));
  } else {
    fail('Stall zero-drop is not immediately reversed by way-too-fast',
      back ? (back.difficultyLeading + '+0x' + Number(back.difficultySecondary).toString(16)) : ('L=' + L));
  }
})();

// --- 6. Inter-zero cooldown + hashrate L cap still hold (no 1→5) ---
(function () {
  const lab = classroomLab(1, 0);
  lab.networkStats.blockIntervals = [300, 300, 280, 310];
  lab.networkStats.totalHashrate = 55000;
  lab.maybeRetargetDifficulty();
  let lastZeroElapsed = 0;
  let maxL = lab.settings.difficultyLeading;
  let maxLeadJump = maxL - 1;
  for (let elapsed = 5000; elapsed <= 60000; elapsed += 5000) {
    lab.networkStats.blockIntervals = [300, 300, 280, 310];
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
    pass('60s of 0.3s blocks still stays at ≤3 zeros',
      'maxL=' + maxL + ' maxLeadJump=' + maxLeadJump);
  } else {
    fail('60s of 0.3s blocks still stays at ≤3 zeros',
      'maxL=' + maxL + ' maxLeadJump=' + maxLeadJump);
  }
})();

// --- 7. Empty wallet re-add does not wipe a known name ---
(function () {
  const lab = new Relay('WALLETNM');
  lab.addOrUpdateParticipant('user_wklpbwzmo', 'wallet', {
    name: 'Wallet 1',
    displayName: 'Wallet 1',
    endowment: 100,
    rename: true
  });
  lab.addOrUpdateParticipant('user_wklpbwzmo', 'wallet', { endowment: 100 });
  const w = lab.participants.get('user_wklpbwzmo');
  if (w && w.displayName === 'Wallet 1' && lab.knownNames.get('user_wklpbwzmo') === 'Wallet 1') {
    pass('Empty wallet re-add keeps Wallet 1 via knownNames', w.displayName);
  } else {
    fail('Empty wallet re-add keeps Wallet 1 via knownNames',
      w ? JSON.stringify({ name: w.name, displayName: w.displayName }) : 'missing');
  }
})();

// --- 8. observe.js has the same persist/restore/broadcast path as participate.js ---
(function () {
  const observe = loadFile('public/javascripts/lab/observe.js');
  const net = loadFile('public/javascripts/network/NetworkManager.js');
  const admin = loadFile('public/javascripts/lab/admin.js');
  const hasRestore = /function restoreNodeNameInput/.test(observe);
  const hasBroadcast = /function persistAndBroadcastNodeName/.test(observe)
    && /displayName:\s*name/.test(observe)
    && /scheduleBroadcastTypedName/.test(observe);
  const reconnect = /transport-reconnected[\s\S]*persistAndBroadcastNodeName/.test(observe);
  const attach = /this\.displayName && !payload\.name/.test(net);
  const liveHub = /labAdminLiveHub_/.test(admin)
    && /!freshCreate && !liveHubTab/.test(admin);
  if (hasRestore && hasBroadcast && reconnect && attach && liveHub) {
    pass('Wallet name persist/restore + live-hub restore toast guard', '');
  } else {
    fail('Wallet name persist/restore + live-hub restore toast guard',
      JSON.stringify({
        hasRestore: hasRestore,
        hasBroadcast: hasBroadcast,
        reconnect: reconnect,
        attach: attach,
        liveHub: liveHub
      }));
  }
})();

// --- 9. Restore toast is gated; live hub marker is set ---
(function () {
  const admin = loadFile('public/javascripts/lab/admin.js');
  const toast = /Session restored from previous tab session/.test(admin);
  const gated = /labAdminLiveHub_/.test(admin)
    && /showToastNotification\('Session restored from previous tab session'/.test(admin)
    && /!freshCreate && !liveHubTab/.test(admin);
  if (toast && gated) {
    pass('Restore toast only when Persistence reloads a previous session', '');
  } else {
    fail('Restore toast only when Persistence reloads a previous session',
      JSON.stringify({ toast: toast, gated: gated }));
  }
})();

// --- 10. Cache-bust p4fix5 on every edited referenced script ---
(function () {
  const adminPug = loadFile('views/lab/admin.pug');
  const partPug = loadFile('views/lab/participate.pug');
  const obsPug = loadFile('views/lab/observe.pug');
  const indexPug = loadFile('views/lab/index.pug');
  const ok =
    /RelayBlockchainState\.js\?v=p4fix7/.test(adminPug + partPug + obsPug + indexPug) &&
    /admin\.js\?v=p4fix7/.test(adminPug) &&
    /observe\.js\?v=p4fix5/.test(obsPug) &&
    /NetworkManager\.js\?v=p4fix5/.test(adminPug + partPug + obsPug);
  if (ok) pass('Edited scripts cache-bust p4fix7', '');
  else fail('Edited scripts cache-bust p4fix7', 'stale ?v=');
})();

const failed = results.filter(function (r) { return !r.ok; });
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
