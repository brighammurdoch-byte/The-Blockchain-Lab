/**
 * Lab URL helpers — work under Express (/lab/...) and GitHub Pages (/BASE/lab/...).
 */
(function (global) {
  function getBasePath() {
    if (typeof global.LAB_BASE_PATH === 'string') {
      return global.LAB_BASE_PATH.replace(/\/$/, '');
    }
    var meta = typeof document !== 'undefined'
      ? document.querySelector('meta[name="lab-base-path"]')
      : null;
    if (meta && meta.content) {
      return String(meta.content).replace(/\/$/, '');
    }
    // Infer from /lab/ in the current path (project Pages: /The-Blockchain-Lab/lab/...)
    var path = (global.location && global.location.pathname) || '';
    var idx = path.indexOf('/lab/');
    if (idx > 0) return path.slice(0, idx);
    if (path.endsWith('/lab') || path.endsWith('/lab/index.html')) {
      return path.replace(/\/lab\/?$/, '').replace(/\/index\.html$/, '');
    }
    return '';
  }

  var RESERVED_SEGMENTS = {
    '': true,
    lab: true,
    admin: true,
    participate: true,
    observe: true,
    demos: true,
    code: true,
    index: true,
    hash: true,
    block: true,
    blockchain: true,
    distributed: true,
    tokens: true,
    coinbase: true,
    bitcoin: true,
    ethereum: true,
    rules: true
  };

  function isSessionCode(value) {
    var s = String(value || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(s)) return false;
    return !RESERVED_SEGMENTS[s.toLowerCase()];
  }

  function getSessionIdFromLocation() {
    var params = new URLSearchParams((global.location && global.location.search) || '');
    var q = params.get('join') || params.get('session') || params.get('code');
    if (isSessionCode(q)) return String(q).trim().toUpperCase();

    var path = (global.location && global.location.pathname) || '';
    // /lab/admin/ABC123 (Express) — never treat /lab/admin or /lab/admin.html as a code
    var parts = path.split('/').filter(Boolean);
    var last = (parts[parts.length - 1] || '').replace(/\.html?$/i, '');
    if (isSessionCode(last)) return last.toUpperCase();
    return '';
  }

  function isStaticMode() {
    return !!(global.LAB_STATIC_MODE ||
      (typeof document !== 'undefined' && document.documentElement &&
        document.documentElement.getAttribute('data-lab-static') === 'true'));
  }

  function persistChainFlavor(sessionId, flavor) {
    var code = String(sessionId || '').toUpperCase();
    var f = String(flavor || '').toLowerCase();
    if (!code || !f) return;
    try { global.localStorage.setItem('chainFlavor_' + code, f); } catch (e) {}
  }

  function getChainFlavor() {
    try {
      var params = new URLSearchParams((global.location && global.location.search) || '');
      var q = String(params.get('chain') || params.get('protocol') || '').toLowerCase();
      if (q === 'btc') q = 'bitcoin';
      if (q === 'eth') q = 'ethereum';
      if (q === 'bitcoin' || q === 'ethereum') return q;
    } catch (e) {}

    var path = (global.location && global.location.pathname) || '';
    if (/\/bitcoin(\/|$|\.)/i.test(path)) return 'bitcoin';
    if (/\/ethereum(\/|$|\.)/i.test(path)) return 'ethereum';

    try {
      var code = getSessionIdFromLocation();
      if (code && global.localStorage) {
        var stored = String(global.localStorage.getItem('chainFlavor_' + code) || '').toLowerCase();
        if (stored === 'btc') stored = 'bitcoin';
        if (stored === 'bitcoin' || stored === 'ethereum') return stored;
      }
    } catch (e2) {}
    return 'classic';
  }

  function withQuery(url, key, value) {
    if (!url || !key || value == null || value === '') return url;
    if (new RegExp('[?&]' + key + '=').test(url)) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + encodeURIComponent(key) + '=' + encodeURIComponent(value);
  }

  /**
   * @param {'index'|'admin'|'participate'|'observe'|'demos'|'code'|'bitcoin'|'ethereum'|'bitcoin-rules'|'ethereum-rules'} page
   * @param {string} [sessionId]
   */
  function labUrl(page, sessionId, extra) {
    var base = getBasePath();
    var code = sessionId ? String(sessionId).toUpperCase() : '';
    var staticMode = isStaticMode();
    var chain = getChainFlavor();
    extra = extra || {};

    if (page === 'bitcoin-rules') {
      return staticMode ? (base + '/bitcoin/rules/') : (base + '/bitcoin/rules');
    }
    if (page === 'ethereum-rules') {
      return staticMode ? (base + '/ethereum/rules/') : (base + '/ethereum/rules');
    }

    if (page === 'bitcoin' || page === 'ethereum') {
      var land = staticMode ? (base + '/' + page + '/') : (base + '/' + page);
      if (code) land += '?join=' + encodeURIComponent(code);
      return land;
    }

    var url;
    if (staticMode) {
      var file = page === 'index' ? 'index.html' : (page + '.html');
      url = base + '/lab/' + file;
      if (code && page === 'index') {
        url += '?join=' + encodeURIComponent(code);
      } else if (code && page !== 'demos') {
        url += '?session=' + encodeURIComponent(code);
      }
    } else if (page === 'index') {
      url = base + '/lab' + (code ? ('?join=' + encodeURIComponent(code)) : '');
    } else if (page === 'demos') {
      url = base + '/lab/demos' + (code ? '/' + code : '');
    } else {
      url = base + '/lab/' + page + (code ? '/' + code : '');
    }

    if (chain && chain !== 'classic' && page !== 'index' && page !== 'demos') {
      url = withQuery(url, 'chain', chain);
    }
    // Per-join identity (same pattern as admin "Open Test Miner Tab")
    if (extra.uid && (page === 'observe' || page === 'participate')) {
      url = withQuery(url, 'uid', extra.uid);
    }
    return url;
  }

  /** Path or site-relative join link for students (landing with code pre-filled). */
  function joinUrl(sessionId) {
    if (getChainFlavor() === 'bitcoin') return labUrl('bitcoin', sessionId);
    if (getChainFlavor() === 'ethereum') return labUrl('ethereum', sessionId);
    return labUrl('index', sessionId);
  }

  function applyClassroomTheme() {
    var flavor = getChainFlavor();
    try {
      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.setAttribute('data-chain-flavor', flavor);
      }
    } catch (e) {}
    var $ = global.jQuery || global.$;
    if (flavor === 'bitcoin' && $) {
      $('.js-unit-label').text('BTC');
      $('#miningRewardLabel').text('Block subsidy (BTC)');
      $('.js-endowment-note').text('Classroom faucet so wallets can send before they mine.');
      if (!$('#chainFlavorBanner').length && $('.lab-session-banner').length) {
        $('.lab-session-banner').prepend(
          '<div class="col-md-12" id="chainFlavorBanner">' +
            '<div class="alert alert-warning" style="margin-bottom:12px;">' +
            '<strong>Bitcoin classroom.</strong> Instructor hub plus miner/wallet nodes — same flow as the main lab. ' +
            'Subsidy starts at 50 BTC and halves every 21 blocks (Core is 210,000; scaled for class). ' +
            'This is a teaching twin, not bitcoind.</div></div>'
        );
      }
    }
    if (flavor === 'ethereum' && $) {
      $('.js-unit-label').text('ETH');
      $('#miningRewardLabel').text('Block issuance (ETH)');
      $('.js-endowment-note').text('Classroom faucet so wallets can send before they mine.');
      if (!$('#chainFlavorBanner').length && $('.lab-session-banner').length) {
        $('.lab-session-banner').prepend(
          '<div class="col-md-12" id="chainFlavorBanner">' +
            '<div class="alert alert-warning" style="margin-bottom:12px;">' +
            '<strong>Ethereum classroom.</strong> Same hub / miner / wallet flow as the main lab. ' +
            'Accounts hold ETH-units. Issuance starts at 5 ETH per block (a teaching twin of old PoW issuance). ' +
            'This is not geth and not the EVM.</div></div>'
        );
      }
    }
    try {
      if (typeof document !== 'undefined' && document.title) {
        if (flavor === 'bitcoin' && !/bitcoin/i.test(document.title)) {
          document.title = document.title.replace('Blockchain Lab', 'Bitcoin Lab');
        }
        if (flavor === 'ethereum' && !/ethereum/i.test(document.title)) {
          document.title = document.title.replace('Blockchain Lab', 'Ethereum Lab');
        }
      }
    } catch (e2) {}
    return flavor;
  }

  /** Absolute https://… join URL for QR codes and sharing. */
  function absoluteJoinUrl(sessionId) {
    var path = joinUrl(sessionId);
    if (/^https?:\/\//i.test(path)) return path;
    var origin = (global.location && global.location.origin) ? global.location.origin : '';
    return origin + path;
  }

  function assetUrl(path) {
    var base = getBasePath();
    if (!path) return base + '/';
    if (path.charAt(0) !== '/') path = '/' + path;
    return base + path;
  }

  function normalizeNodeRole(role) {
    var r = String(role || '').toLowerCase();
    if (r === 'observer') return 'wallet';
    if (r === 'participant') return 'miner';
    if (r === 'wallet' || r === 'miner' || r === 'admin' || r === 'hub') return r;
    return '';
  }

  function persistNodeRole(sessionId, userId, role) {
    var code = String(sessionId || '').toUpperCase();
    var r = normalizeNodeRole(role);
    if (!code || !r) return;
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem('userRole_' + code, r);
      if (userId) {
        localStorage.setItem('userRole_' + code + '_' + userId, r);
        // Do NOT write userId_CODE_role / userId_CODE. That shared key is how a
        // second wallet join on the same origin adopted Wallet 1 (L3T0NE).
      }
    } catch (e) {}
  }

  function getBoundNodeRole(sessionId, userId) {
    var code = String(sessionId || '').toUpperCase();
    try {
      if (typeof localStorage === 'undefined') return '';
      if (userId) {
        var specific = localStorage.getItem('userRole_' + code + '_' + userId);
        if (specific) return normalizeNodeRole(specific);
      }
      return normalizeNodeRole(localStorage.getItem('userRole_' + code) || '');
    } catch (e) {
      return '';
    }
  }

  function getUserIdForRole(sessionId, role) {
    var code = String(sessionId || '').toUpperCase();
    var r = normalizeNodeRole(role);
    if (!code || !r) return '';
    try {
      if (typeof localStorage === 'undefined') return '';
      return localStorage.getItem('userId_' + code + '_' + r) || '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Identity for THIS browser tab. sessionStorage is per-tab, so a second
   * wallet/miner join in another tab cannot steal the first tab's userId.
   * Do not read localStorage userId_SESSION_role for a fresh tab — that is
   * how Wallet 2 overwrote Wallet 1 on the hub.
   */
  function allocateTabUserId(sessionId, role, opts) {
    var code = String(sessionId || '').toUpperCase();
    var r = normalizeNodeRole(role) || 'miner';
    opts = opts || {};
    var fromQuery = String(opts.uid || '').trim();
    var ssKey = 'labUserId_' + code;
    if (fromQuery) {
      try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(ssKey, fromQuery); } catch (e) {}
      persistNodeRole(code, fromQuery, r);
      return fromQuery;
    }
    try {
      if (typeof sessionStorage !== 'undefined') {
        var fromTab = sessionStorage.getItem(ssKey);
        if (fromTab) {
          persistNodeRole(code, fromTab, r);
          return fromTab;
        }
      }
    } catch (e2) {}
    // observe.html?session= without ?uid= must not mint another classroom student.
    // Landing Join is the only place that should call mintJoinUserId.
    if (opts.mint === false) return '';
    return mintJoinUserId(code, r);
  }

  /** Keep ?uid= on observe/participate so a refresh does not mint a new student. */
  function pinUidInLocation(userId) {
    var id = String(userId || '').trim();
    if (!id || typeof global.location === 'undefined') return;
    try {
      var url = new URL(global.location.href);
      if (url.searchParams.get('uid') === id) return;
      url.searchParams.set('uid', id);
      if (global.history && typeof global.history.replaceState === 'function') {
        global.history.replaceState({}, '', url.toString());
      }
    } catch (e) {}
  }

  /**
   * Always mint a brand-new classroom id. Used on landing Join so a second
   * wallet on the same browser profile cannot adopt userId_SESSION_wallet.
   */
  function mintJoinUserId(sessionId, role) {
    var code = String(sessionId || '').toUpperCase();
    var r = normalizeNodeRole(role) || 'miner';
    var id = 'user_' + Math.random().toString(36).substr(2, 9);
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('labUserId_' + code, id);
    } catch (e) {}
    persistNodeRole(code, id, r);
    return id;
  }

  /**
   * If this userId is bound to the other classroom role, send them back.
   * @param {'miner'|'wallet'} expectedRole
   * @param {string} sessionId
   * @param {string} userId
   * @returns {boolean} true if a redirect was started
   */
  function enforceBoundRolePage(expectedRole, sessionId, userId) {
    var want = normalizeNodeRole(expectedRole);
    var bound = getBoundNodeRole(sessionId, userId);
    if (!bound || !want || bound === want) return false;
    if (bound === 'admin' || bound === 'hub') return false;
    var page = bound === 'wallet' ? 'observe' : 'participate';
    if (typeof global.location !== 'undefined') {
      global.location.replace(labUrl(page, sessionId, userId ? { uid: userId } : {}));
    }
    return true;
  }

  global.LabPaths = {
    getBasePath: getBasePath,
    getSessionIdFromLocation: getSessionIdFromLocation,
    isSessionCode: isSessionCode,
    getChainFlavor: getChainFlavor,
    persistChainFlavor: persistChainFlavor,
    applyClassroomTheme: applyClassroomTheme,
    labUrl: labUrl,
    joinUrl: joinUrl,
    absoluteJoinUrl: absoluteJoinUrl,
    assetUrl: assetUrl,
    normalizeNodeRole: normalizeNodeRole,
    persistNodeRole: persistNodeRole,
    getBoundNodeRole: getBoundNodeRole,
    getUserIdForRole: getUserIdForRole,
    allocateTabUserId: allocateTabUserId,
    mintJoinUserId: mintJoinUserId,
    pinUidInLocation: pinUidInLocation,
    withQuery: withQuery,
    enforceBoundRolePage: enforceBoundRolePage
  };
})(typeof window !== 'undefined' ? window : globalThis);
