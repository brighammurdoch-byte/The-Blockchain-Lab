/**
 * Headless checks for Pass 11 leftover-URL rehost (IF16FZ / p4fix8):
 * admin.html?session=CODE without this-tab live-hub / fresh-create flags
 * must not host. Bare URL still does not mint. Real Create + live refresh
 * still host. Existing pass1–pass10 stay green.
 * Usage: node scripts/pass11-live-fix-test.js
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

function loadAdminHubFns(sessionStore, localStore) {
  const src = loadFile('public/javascripts/lab/admin.js');
  const start = src.indexOf('function adminShouldHostSession');
  const end = src.indexOf('function formatDifficultyLabel');
  if (start < 0 || end < 0) return null;
  const snippet = src.slice(start, end);
  const session = sessionStore || {};
  const local = localStore || {};
  const ctx = {
    window: {},
    sessionStorage: {
      getItem: function (k) {
        return Object.prototype.hasOwnProperty.call(session, k) ? session[k] : null;
      },
      setItem: function (k, v) { session[k] = String(v); },
      removeItem: function (k) { delete session[k]; }
    },
    localStorage: {
      getItem: function (k) {
        return Object.prototype.hasOwnProperty.call(local, k) ? local[k] : null;
      },
      setItem: function (k, v) { local[k] = String(v); },
      removeItem: function (k) { delete local[k]; }
    },
    Persistence: {
      isLiveAdminHub: function (code) {
        return session['labAdminLiveHub_' + String(code || '').toUpperCase()] === '1';
      }
    },
    LabPaths: {
      isSessionCode: function (value) {
        var s = String(value || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,8}$/.test(s)) return false;
        return s !== 'ADMIN' && s !== 'INDEX' && s !== 'LAB';
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(
    snippet +
    '\nthis.adminShouldHostSession = adminShouldHostSession;' +
    '\nthis.adminTabOwnsHub = adminTabOwnsHub;',
    ctx
  );
  return {
    shouldEnter: function (code) {
      return ctx.adminShouldHostSession(code) && ctx.adminTabOwnsHub(code);
    },
    adminShouldHostSession: ctx.adminShouldHostSession,
    adminTabOwnsHub: ctx.adminTabOwnsHub,
    session: session,
    local: local
  };
}

// --- 1. Leftover ?session=CODE without this-tab flags does not host ---
(function () {
  const fns = loadAdminHubFns({});
  const leftover = '91G5M2';
  const shapeOk = fns && fns.adminShouldHostSession(leftover) === true;
  const owns = fns && fns.adminTabOwnsHub(leftover);
  const enter = fns && fns.shouldEnter(leftover);
  if (shapeOk && owns === false && enter === false) {
    pass('Leftover session query without this-tab live-hub flag does not host', leftover);
  } else {
    fail('Leftover session query without this-tab live-hub flag does not host',
      JSON.stringify({ shapeOk: shapeOk, owns: owns, enter: enter }));
  }
})();

// --- 2. Leftover localStorage persist must not grant ownership ---
(function () {
  const fns = loadAdminHubFns({}, {
    'blockchain-lab-admin-91G5M2': JSON.stringify({ chain: [{ index: 0 }, { index: 1 }] }),
    'joinCode_91G5M2': '91G5M2',
    'isAdmin_91G5M2': 'true'
  });
  if (fns && fns.shouldEnter('91G5M2') === false && fns.adminTabOwnsHub('91G5M2') === false) {
    pass('Leftover localStorage persist does not rehost a leftover URL', '');
  } else {
    fail('Leftover localStorage persist does not rehost a leftover URL',
      fns ? 'owned=' + fns.adminTabOwnsHub('91G5M2') : 'missing helper');
  }
})();

// --- 3. Fresh Create flag in this tab still hosts ---
(function () {
  const fns = loadAdminHubFns({ labAdminFreshCreate_IF16FZ: '1' });
  if (fns && fns.shouldEnter('IF16FZ') === true && fns.adminTabOwnsHub('IF16FZ') === true) {
    pass('Fresh Create flag in this tab still hosts', 'IF16FZ');
  } else {
    fail('Fresh Create flag in this tab still hosts',
      fns ? 'enter=' + fns.shouldEnter('IF16FZ') : 'missing helper');
  }
})();

// --- 4. Live-hub refresh flag in this tab still hosts ---
(function () {
  const fns = loadAdminHubFns({ labAdminLiveHub_IF16FZ: '1' });
  if (fns && fns.shouldEnter('IF16FZ') === true) {
    pass('Live hub refresh of the same tab still hosts', 'IF16FZ');
  } else {
    fail('Live hub refresh of the same tab still hosts',
      fns ? 'enter=' + fns.shouldEnter('IF16FZ') : 'missing helper');
  }
})();

// --- 5. Bare / empty URL still does not mint (held) ---
(function () {
  const fns = loadAdminHubFns({});
  const admin = loadFile('public/javascripts/lab/admin.js');
  const gated = fns
    && fns.shouldEnter('') === false
    && fns.shouldEnter(null) === false
    && fns.adminShouldHostSession('ADMIN') === false
    && /adminShouldHostSession\(sessionId\)/.test(admin)
    && /adminTabOwnsHub\(sessionId\)/.test(admin)
    && /location\.replace/.test(admin)
    && !/\.createRoom\(/.test(admin);
  if (gated) pass('Bare admin.html still does not mint; leftover URL uses the same replace', '');
  else fail('Bare admin.html still does not mint; leftover URL uses the same replace',
    fns ? JSON.stringify({
      empty: fns.shouldEnter(''),
      admin: fns.adminShouldHostSession('ADMIN'),
      createRoom: /\.createRoom\(/.test(admin)
    }) : 'missing helper');
})();

// --- 6. Landing Create stays single-flight; stale hub flags are dropped ---
(function () {
  const landing = loadFile('public/javascripts/lab/landing.js');
  const lock = /createInFlight/.test(landing)
    && /prop\('disabled'\)/.test(landing)
    && /Creating…/.test(landing)
    && /labAdminFreshCreate_/.test(landing)
    && /labAdminLiveHub_/.test(landing)
    && /sessionStorage\.removeItem/.test(landing);
  if (lock) pass('Create Session is single-flight and drops leftover hub flags', '');
  else fail('Create Session is single-flight and drops leftover hub flags', 'missing lock or stale-flag clear');
})();

// --- 7. Held: stall-ease / join stagger / live-hub toast gate still present ---
(function () {
  const admin = loadFile('public/javascripts/lab/admin.js');
  const joinStagger = /scheduleJoinUiPaints/.test(admin)
    && /Join toast must not rebuild/.test(admin);
  const liveHub = /labAdminLiveHub_/.test(admin)
    && /!freshCreate && !liveHubTab/.test(admin);
  if (joinStagger && liveHub) {
    pass('Held join-paint stagger and live-hub restore toast gate stay in place', '');
  } else {
    fail('Held join-paint stagger and live-hub restore toast gate stay in place',
      JSON.stringify({ joinStagger: joinStagger, liveHub: liveHub }));
  }
})();

// --- 8. Cache-bust p4fix8 on every edited referenced script ---
(function () {
  const adminPug = loadFile('views/lab/admin.pug');
  const indexPug = loadFile('views/lab/index.pug');
  const btcPug = loadFile('views/lab/bitcoin.pug');
  const ok =
    /admin\.js\?v=p4fix8/.test(adminPug) &&
    /landing\.js\?v=p4fix8/.test(indexPug) &&
    /landing\.js\?v=p4fix8/.test(btcPug);
  if (ok) pass('Edited scripts cache-bust p4fix8', '');
  else fail('Edited scripts cache-bust p4fix8', 'stale ?v=');
})();

const failed = results.filter(function (r) { return !r.ok; });
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
