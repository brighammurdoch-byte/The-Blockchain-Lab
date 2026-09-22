/**
 * Per-tab mining pace: default is gentle, 100% and hidden tabs stay under the cap,
 * and a posted delay of 0 / batch of 8000 cannot bypass the worker clamp.
 * Usage: node scripts/hash-pace-unit-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const results = [];
function pass(n, d) { results.push({ ok: true, n, d }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); }
function fail(n, d) { results.push({ ok: false, n, d }); console.log('FAIL  ' + n + ' — ' + d); }

function load(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function sliceFunction(src, name) {
  const sig = 'function ' + name + '(';
  const start = src.indexOf(sig);
  if (start < 0) throw new Error('missing ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

function impliedHps(pace) {
  return (pace.batchSize / pace.delay) * 1000;
}

const participate = load('public/javascripts/lab/participate.js');
const workerFile = load('public/javascripts/lab/miningWorker.js');
const relay = load('public/javascripts/network/RelayBlockchainState.js');
const pug = load('views/lab/participate.pug');

const paceSrc =
  participate.slice(participate.indexOf('const TAB_HASH_CAP'), participate.indexOf('\n', participate.indexOf('const TAB_HASH_CAP'))) +
  '\n' +
  sliceFunction(participate, 'classroomMiningPace');
const paceCtx = vm.runInNewContext(
  '(function(){\n' + paceSrc + '\nreturn { classroomMiningPace: classroomMiningPace, TAB_HASH_CAP: TAB_HASH_CAP };\n})()'
);

function loadClamp(src) {
  const capLine = src.slice(src.indexOf('var TAB_HASH_CAP'), src.indexOf('\n', src.indexOf('var TAB_HASH_CAP')));
  const fn = sliceFunction(src, 'clampPace');
  return vm.runInNewContext(
    '(function(){\n' + capLine + '\n' + fn + '\nreturn clampPace;\n})()'
  );
}

const clampInline = loadClamp(participate);
const clampFile = loadClamp(workerFile);

(function () {
  if (paceCtx.TAB_HASH_CAP === 750) pass('Tab hash cap is 750 H/s', '750');
  else fail('Tab hash cap is 750 H/s', String(paceCtx.TAB_HASH_CAP));
})();

(function () {
  const pace = paceCtx.classroomMiningPace(30, false);
  const hps = impliedHps(pace);
  if (pace.targetHps === 225 && pace.batchSize === 40 && pace.delay === 178 && hps <= 750 && hps >= 200) {
    pass('Default visible pace is about 225 H/s', JSON.stringify(pace));
  } else {
    fail('Default visible pace is about 225 H/s', JSON.stringify(pace) + ' hps=' + hps);
  }
})();

(function () {
  const pace = paceCtx.classroomMiningPace(100, false);
  const hps = impliedHps(pace);
  if (pace.targetHps === 750 && pace.delay > 0 && pace.batchSize <= 80 && hps <= 750) {
    pass('Slider 100% stays at or under 750 H/s', 'implied=' + Math.round(hps));
  } else {
    fail('Slider 100% stays at or under 750 H/s', JSON.stringify(pace) + ' hps=' + hps);
  }
})();

(function () {
  const visible = paceCtx.classroomMiningPace(30, false);
  const hidden = paceCtx.classroomMiningPace(30, true);
  const ok =
    hidden.targetHps < visible.targetHps &&
    hidden.targetHps === 135 &&
    hidden.delay > 0 &&
    impliedHps(hidden) < impliedHps(visible) &&
    impliedHps(hidden) <= 750;
  if (ok) pass('Hidden tab is slower than the visible default', JSON.stringify(hidden));
  else fail('Hidden tab is slower than the visible default', JSON.stringify(hidden));
})();

(function () {
  const bad = [];
  [10, 30, 50, 100].forEach(function (pct) {
    [false, true].forEach(function (hidden) {
      const pace = paceCtx.classroomMiningPace(pct, hidden);
      const hps = impliedHps(pace);
      if (!(pace.delay >= 25) || pace.batchSize > 80 || hps > 750) {
        bad.push(pct + (hidden ? ' hidden ' : ' visible ') + JSON.stringify(pace) + ' hps=' + hps);
      }
    });
  });
  if (!bad.length) pass('Every slider step yields and stays under the cap', '');
  else fail('Every slider step yields and stays under the cap', bad.join('; '));
})();

(function () {
  function check(name, clamp) {
    const forced = clamp(0, 8000);
    const hps = impliedHps(forced);
    const slow = clamp(500, 10);
    if (
      forced.batchSize === 80 &&
      forced.delay >= 107 &&
      hps <= 750 &&
      slow.delay === 500 &&
      slow.batchSize === 10
    ) {
      pass(name + ' clamps delay 0 / batch 8000', JSON.stringify(forced));
    } else {
      fail(name + ' clamps delay 0 / batch 8000', 'forced=' + JSON.stringify(forced) + ' slow=' + JSON.stringify(slow));
    }
  }
  check('Inline worker', clampInline);
  check('miningWorker.js', clampFile);
})();

(function () {
  const uncapped =
    /batchSize:\s*hidden\s*\?\s*8000/.test(participate) ||
    /hidden\s*\?\s*0\s*:/.test(participate) ||
    /document\.hidden\s*\?\s*0/.test(participate);
  const capped =
    /let cpuLimitPercent = 30;/.test(participate) &&
    /Math\.min\(20,\s*pace\.batchSize\)/.test(participate) &&
    /Math\.max\(40,\s*Math\.ceil/.test(participate);
  if (!uncapped && capped) pass('Page no longer uses hidden-tab max pace', '');
  else fail('Page no longer uses hidden-tab max pace', 'uncapped=' + uncapped + ' capped=' + capped);
})();

(function () {
  if (
    /participate\.js\?v=p4fix14/.test(pug) &&
    /value="30"/.test(pug) &&
    /750 hashes\/sec/.test(pug)
  ) {
    pass('Miner page default is 30% and documents the cap', '');
  } else {
    fail('Miner page default is 30% and documents the cap', 'pug mismatch');
  }
})();

(function () {
  if (
    /const RETARGET_INTERVAL_WINDOW = 12;/.test(relay) &&
    /targetBlockTimeSec: 10/.test(relay) &&
    /Start at 3 \+ 0x8/.test(relay)
  ) {
    pass('Difficulty defaults are unchanged', '3+0x8, 10s, window 12');
  } else {
    fail('Difficulty defaults are unchanged', 'retarget or start difficulty moved');
  }
})();

const failed = results.filter(function (r) { return !r.ok; }).length;
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
