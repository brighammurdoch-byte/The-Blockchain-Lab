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
   * @param {'index'|'admin'|'participate'|'observe'|'demos'|'code'|'bitcoin'|'ethereum'|'bitcoin-rules'} page
   * @param {string} [sessionId]
   */
  function labUrl(page, sessionId) {
    var base = getBasePath();
    var code = sessionId ? String(sessionId).toUpperCase() : '';
    var staticMode = isStaticMode();
    var chain = getChainFlavor();

    if (page === 'bitcoin-rules') {
      return staticMode ? (base + '/bitcoin/rules/') : (base + '/bitcoin/rules');
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
    if (flavor !== 'bitcoin') return flavor;

    var $ = global.jQuery || global.$;
    if ($) {
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
    try {
      if (typeof document !== 'undefined' && document.title && !/bitcoin/i.test(document.title)) {
        document.title = document.title.replace('Blockchain Lab', 'Bitcoin Lab');
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
    assetUrl: assetUrl
  };
})(typeof window !== 'undefined' ? window : globalThis);
