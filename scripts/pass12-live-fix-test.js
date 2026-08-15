/**
 * Headless checks for Pass 12 Create Session quota prune (p4fix9):
 * QuotaExceededError on setItem prunes leftover admin-state for other
 * codes, retries once, and never wipes the live room or this-tab hub flags.
 * Existing pass1–pass11 stay green. Usage: node scripts/pass12-live-fix-test.js
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

function makeStorage(initial) {
  const data = Object.assign({}, initial || {});
  let cleared = false;
  const api = {
    get length() { return Object.keys(data).length; },
    key: function (i) { return Object.keys(data)[i] || null; },
    getItem: function (k) {
      return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
    },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; },
    clear: function () {
      cleared = true;
      Object.keys(data).forEach(function (k) { delete data[k]; });
    },
    _data: data,
    _wasCleared: function () { return cleared; }
  };
  return api;
}

function loadPersistence(localStore, sessionStore) {
  const src = loadFile('public/javascripts/network/Persistence.js');
  const ctx = {
    window: {},
    console: console,
    localStorage: localStore,
    sessionStorage: sessionStore
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.Persistence;
}

// --- 1. QuotaExceededError on setItem prunes leftover admin-state and retries ---
(function () {
  const leftoverCodes = ['XU1J1S', 'JQQC4D', 'ST0R8T', 'IF16FZ', 'ESRZ7B', 'MYDFSN', '91G5M2'];
  const localInit = {
    'joinCode_22UM0P': 'pending',
    'adminUserId_22UM0P': 'admin-keep',
    'blockchain-lab-admin-22UM0P': JSON.stringify({ chain: [{ index: 0 }] }),
    blockchainLabDebug: 'true'
  };
  leftoverCodes.forEach(function (code) {
    localInit['blockchain-lab-admin-' + code] = JSON.stringify({
      chain: new Array(40).fill({ index: 0, hash: 'x'.repeat(64) }),
      participants: { many: true }
    });
    localInit['joinCode_' + code] = code;
    localInit['adminUserId_' + code] = 'admin-' + code;
    localInit['networkingMode_' + code] = 'admin-relay';
    localInit['isAdmin_' + code] = 'true';
  });
  const local = makeStorage(localInit);
  const session = makeStorage({
    labAdminLiveHub_XU1J1S: '1',
    labAdminFreshCreate_IF16FZ: '1'
  });

  let firstJoinWrite = true;
  const realSet = local.setItem.bind(local);
  local.setItem = function (k, v) {
    if (firstJoinWrite && k === 'joinCode_22UM0P') {
      firstJoinWrite = false;
      const err = new Error(
        "Failed to execute 'setItem' on 'Storage': Setting the value of 'joinCode_22UM0P' exceeded the quota."
      );
      err.name = 'QuotaExceededError';
      throw err;
    }
    return realSet(k, v);
  };

  const P = loadPersistence(local, session);
  let threw = null;
  try {
    P.setLocalItem('joinCode_22UM0P', '22UM0P', '22UM0P');
  } catch (e) {
    threw = e;
  }

  const leftoverGone = leftoverCodes.every(function (code) {
    return local.getItem('blockchain-lab-admin-' + code) == null
      && local.getItem('joinCode_' + code) == null
      && local.getItem('adminUserId_' + code) == null;
  });
  const keptLive = local.getItem('joinCode_22UM0P') === '22UM0P'
    && local.getItem('adminUserId_22UM0P') === 'admin-keep'
    && !!local.getItem('blockchain-lab-admin-22UM0P');
  const keptFlags = session.getItem('labAdminLiveHub_XU1J1S') === '1'
    && session.getItem('labAdminFreshCreate_IF16FZ') === '1';
  const keptUnrelated = local.getItem('blockchainLabDebug') === 'true';
  const noBlindWipe = local._wasCleared() === false;

  if (!threw && leftoverGone && keptLive && keptFlags && keptUnrelated && noBlindWipe) {
    pass('QuotaExceededError on setItem prunes leftover admin-state and retries', '22UM0P kept');
  } else {
    fail('QuotaExceededError on setItem prunes leftover admin-state and retries',
      JSON.stringify({
        threw: threw && threw.message,
        leftoverGone: leftoverGone,
        keptLive: keptLive,
        keptFlags: keptFlags,
        keptUnrelated: keptUnrelated,
        noBlindWipe: noBlindWipe,
        firstJoinWrite: firstJoinWrite
      }));
  }
})();

// --- 2. Targeted prune never deletes the room being created ---
(function () {
  const local = makeStorage({
    'blockchain-lab-admin-RID0Y6': '{"chain":[1]}',
    'joinCode_RID0Y6': 'RID0Y6',
    'adminUserId_RID0Y6': 'admin-live',
    'blockchain-lab-admin-91G5M2': '{"chain":[9]}',
    'joinCode_91G5M2': '91G5M2'
  });
  const session = makeStorage({ labAdminLiveHub_RID0Y6: '1' });
  const P = loadPersistence(local, session);
  const removed = P.pruneLeftoverClassroomKeys('RID0Y6');
  const ok = local.getItem('joinCode_RID0Y6') === 'RID0Y6'
    && local.getItem('adminUserId_RID0Y6') === 'admin-live'
    && local.getItem('blockchain-lab-admin-RID0Y6') === '{"chain":[1]}'
    && local.getItem('joinCode_91G5M2') == null
    && local.getItem('blockchain-lab-admin-91G5M2') == null
    && removed.indexOf('blockchain-lab-admin-91G5M2') !== -1
    && session.getItem('labAdminLiveHub_RID0Y6') === '1'
    && local._wasCleared() === false;
  if (ok) pass('Targeted prune keeps the live room and this-tab hub flags', '');
  else fail('Targeted prune keeps the live room and this-tab hub flags',
    JSON.stringify({ removed: removed, data: local._data, session: session._data }));
})();

// --- 3. Landing Create uses Persistence.setLocalItem (quota retry) ---
(function () {
  const landing = loadFile('public/javascripts/lab/landing.js');
  const wired = /function persistClassroomItem/.test(landing)
    && /Persistence\.setLocalItem/.test(landing)
    && /persistClassroomItem\('joinCode_'/.test(landing)
    && /persistClassroomItem\('adminUserId_'/.test(landing)
    && /persistClassroomItem\('networkingMode_'/.test(landing)
    && /createInFlight/.test(landing)
    && /pageshow/.test(landing)
    && /nav\.persisted/.test(landing)
    && !/localStorage\.clear\(/.test(landing);
  if (wired) pass('Landing Create writes through quota-retry helper; button resets on bfcache Back', '');
  else fail('Landing Create writes through quota-retry helper; button resets on bfcache Back', 'missing persistClassroomItem / pageshow');
})();

// --- 4. Held: leftover-URL rehost gate and stall-ease / join stagger stay ---
(function () {
  const admin = loadFile('public/javascripts/lab/admin.js');
  const leftoverGate = /function adminShouldHostSession/.test(admin)
    && /function adminTabOwnsHub/.test(admin)
    && /adminShouldHostSession\(sessionId\)/.test(admin)
    && /adminTabOwnsHub\(sessionId\)/.test(admin)
    && /location\.replace/.test(admin)
    && !/\.createRoom\(/.test(admin);
  const held = /scheduleJoinUiPaints/.test(admin)
    && /Join toast must not rebuild/.test(admin)
    && /labAdminLiveHub_/.test(admin);
  if (leftoverGate && held) {
    pass('Held leftover-URL rehost gate and p4fix7 stall-ease / join stagger stay', '');
  } else {
    fail('Held leftover-URL rehost gate and p4fix7 stall-ease / join stagger stay',
      JSON.stringify({ leftoverGate: leftoverGate, held: held }));
  }
})();

// --- 5. Cache-bust p4fix9 on every edited referenced script ---
(function () {
  const adminPug = loadFile('views/lab/admin.pug');
  const indexPug = loadFile('views/lab/index.pug');
  const btcPug = loadFile('views/lab/bitcoin.pug');
  const partPug = loadFile('views/lab/participate.pug');
  const obsPug = loadFile('views/lab/observe.pug');
  const ok =
    /Persistence\.js\?v=p4fix9/.test(adminPug) &&
    /Persistence\.js\?v=p4fix9/.test(indexPug) &&
    /Persistence\.js\?v=p4fix9/.test(btcPug) &&
    /Persistence\.js\?v=p4fix9/.test(partPug) &&
    /Persistence\.js\?v=p4fix9/.test(obsPug) &&
    /landing\.js\?v=p4fix9/.test(indexPug) &&
    /landing\.js\?v=p4fix9/.test(btcPug) &&
    /admin\.js\?v=p4fix8/.test(adminPug);
  if (ok) pass('Edited scripts cache-bust p4fix9', '');
  else fail('Edited scripts cache-bust p4fix9', 'stale ?v=');
})();

const failed = results.filter(function (r) { return !r.ok; });
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
