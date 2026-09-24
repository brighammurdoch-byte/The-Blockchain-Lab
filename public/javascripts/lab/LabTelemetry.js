/**
 * Cookieless classroom analytics (GoatCounter).
 *
 * Set GOATCOUNTER_CODE to the site code from https://www.goatcounter.com
 * (the subdomain in https://CODE.goatcounter.com). Leave it '' to send
 * nothing — do not commit a placeholder code.
 *
 *   public/javascripts/lab/LabTelemetry.js  →  var GOATCOUNTER_CODE = '';
 *
 * Then run `npm run build:static` so GitHub Pages serves the update.
 *
 * Debug (logs each event name, even when the code is empty):
 *   ?telemetryDebug=1   remembered for this tab
 *   localStorage.setItem('telemetryDebug', '1')
 */
var GOATCOUNTER_CODE = '';

(function (global) {
  'use strict';

  if (global.LabTelemetry) return;

  var ALLOWED = {
    page_lab_landing: true,
    session_created: true,
    student_joined: true,
    role_miner: true,
    role_wallet: true,
    mining_started: true,
    network_mode_p2p: true,
    attack_51: true,
    hard_fork: true
  };

  var siteCode = normalizeCode(typeof GOATCOUNTER_CODE === 'string' ? GOATCOUNTER_CODE : '');
  var pending = [];
  var scriptRequested = false;

  function normalizeCode(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    var fromUrl = s.match(/^(?:https?:\/\/)?([a-z0-9-]+)\.goatcounter\.com\b/i);
    if (fromUrl) s = fromUrl[1];
    s = s.replace(/^https?:\/\//i, '').split('/')[0];
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/i.test(s)) return '';
    return s.toLowerCase();
  }

  function debugEnabled() {
    try {
      var search = (global.location && global.location.search) || '';
      if (/(?:^|[?&])telemetryDebug=1(?:&|$)/.test(search)) {
        try { global.sessionStorage.setItem('telemetryDebug', '1'); } catch (e1) {}
        return true;
      }
      if (global.sessionStorage && global.sessionStorage.getItem('telemetryDebug') === '1') return true;
      if (global.localStorage && global.localStorage.getItem('telemetryDebug') === '1') return true;
    } catch (e2) {}
    return false;
  }

  function isLabSurface() {
    var path = '';
    try { path = String((global.location && global.location.pathname) || ''); } catch (e) { return false; }
    return /\/lab(\/|$)/i.test(path) || /\/bitcoin(\/|$)/i.test(path) || /\/ethereum(\/|$)/i.test(path);
  }

  // Join codes are 4–8 uppercase letters/digits in the path (Express)
  // or in the query string (?session= / ?join= / ?uid=). Never forward those.
  function isSessionSegment(segment) {
    var bare = String(segment || '').replace(/\.html?$/i, '');
    return /^[A-Z0-9]{4,8}$/.test(bare);
  }

  function stripSessionSegments(pathname) {
    var parts = String(pathname || '').split('/');
    var kept = [];
    for (var i = 0; i < parts.length; i++) {
      if (isSessionSegment(parts[i])) continue;
      kept.push(parts[i]);
    }
    return kept.join('/');
  }

  function sanitizePath(value) {
    try {
      var s = String(value == null ? '' : value);
      if (!s) return '/';
      if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
        s = new URL(s).pathname || '/';
      }
      var cut = s.search(/[?#]/);
      if (cut >= 0) s = s.slice(0, cut);
      s = stripSessionSegments(s);
      if (!s) return '/';
      if (s.charAt(0) !== '/') s = '/' + s;
      s = s.replace(/\/{2,}/g, '/');
      if (/[?#=&]/.test(s)) return '/';
      return s || '/';
    } catch (e) {
      return '/';
    }
  }

  function sanitizeReferrer(value) {
    try {
      var s = String(value == null ? '' : value);
      if (!s) return '';
      if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
        var abs = new URL(s);
        return abs.origin + sanitizePath(abs.pathname || '/');
      }
      return sanitizePath(s);
    } catch (e) {
      return '';
    }
  }

  function scrubPayload(data) {
    if (!data || typeof data !== 'object') return data;
    // count.js always copies location.search into q. Drop it.
    data.q = '';
    if (data.e) {
      if (!ALLOWED[String(data.p || '')]) data.p = null;
    } else if (typeof data.p === 'string' || data.p == null) {
      data.p = sanitizePath(data.p);
    }
    if (typeof data.r === 'string') data.r = sanitizeReferrer(data.r);
    return data;
  }

  function payloadLeaks(url) {
    var decoded = String(url || '');
    try { decoded = decodeURIComponent(decoded); } catch (e) {}
    if (/[?&#](?:session|join|uid|userId|userid|room|roomId|code)=/i.test(decoded)) return true;
    if (/\/[A-Z0-9]{4,8}(?:\/|$|\?|#)/.test(decoded)) return true;
    return false;
  }

  function patchGoatCounter() {
    var gc = global.goatcounter;
    if (!gc || gc.__labSafe) return;
    if (typeof gc.get_data === 'function') {
      var origData = gc.get_data;
      gc.get_data = function (vars) {
        try { return scrubPayload(origData(vars)); } catch (e) { return { p: null, q: '' }; }
      };
    }
    if (typeof gc.url === 'function') {
      var origUrl = gc.url;
      gc.url = function (vars) {
        var raw;
        try { raw = origUrl(vars); } catch (e) { return; }
        if (!raw || payloadLeaks(raw)) return;
        return raw;
      };
    }
    if (typeof gc.count === 'function') {
      var origCount = gc.count;
      gc.count = function (vars) {
        try {
          if (typeof gc.filter === 'function' && gc.filter()) return;
          var dest = typeof gc.url === 'function' ? gc.url(vars) : '';
          if (!dest || payloadLeaks(dest)) return;
          return origCount.call(gc, vars);
        } catch (e) {}
      };
    }
    gc.__labSafe = true;
  }

  function deliver(vars) {
    try {
      var gc = global.goatcounter;
      if (!gc || typeof gc.count !== 'function') return false;
      patchGoatCounter();
      gc.count(vars);
      return true;
    } catch (e) {
      return false;
    }
  }

  function enqueue(vars) {
    if (!siteCode || !isLabSurface()) return;
    if (deliver(vars)) return;
    if (pending.length < 24) pending.push(vars);
  }

  function flush() {
    var queued = pending.splice(0, pending.length);
    for (var i = 0; i < queued.length; i++) deliver(queued[i]);
  }

  function sendPageview() {
    enqueue({
      path: sanitizePath((global.location && global.location.pathname) || '/'),
      title: (global.document && global.document.title) || 'Blockchain Lab',
      referrer: sanitizeReferrer((global.document && global.document.referrer) || ''),
      event: false
    });
  }

  function install() {
    if (!siteCode || !isLabSurface() || scriptRequested) return;
    scriptRequested = true;
    try {
      global.goatcounter = global.goatcounter || {};
      // Count ourselves so we can strip location.search before anything is sent.
      global.goatcounter.no_onload = true;
      global.goatcounter.no_events = true;
      global.goatcounter.path = function (p) { return sanitizePath(p || (global.location && global.location.pathname) || '/'); };
      global.goatcounter.referrer = function (r) { return sanitizeReferrer(r || ''); };

      var script = global.document.createElement('script');
      script.async = true;
      script.src = 'https://gc.zgo.at/count.js';
      script.setAttribute('data-goatcounter', 'https://' + siteCode + '.goatcounter.com/count');
      script.onerror = function () {};
      script.onload = function () {
        try {
          patchGoatCounter();
          sendPageview();
          flush();
        } catch (e) {}
      };
      var parent = global.document.head || global.document.body || global.document.documentElement;
      if (parent) parent.appendChild(script);
    } catch (e) {
      scriptRequested = false;
    }
  }

  function event(name) {
    try {
      if (typeof name !== 'string' || !ALLOWED[name]) return;
      if (debugEnabled()) {
        try { console.log('[telemetry] ' + name); } catch (eLog) {}
      }
      enqueue({ path: name, event: true, title: name, referrer: '' });
    } catch (e) {}
  }

  global.LabTelemetry = { event: event };

  try { install(); } catch (e) {}
})(typeof window !== 'undefined' ? window : this);
