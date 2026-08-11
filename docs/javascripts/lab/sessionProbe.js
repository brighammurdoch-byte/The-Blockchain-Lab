/**
 * Verify a session code against a live instructor hub before joining.
 * Used by landing + participate/observe (direct URL protection).
 */
(function (global) {
  var JOIN_PROBE_MS = 8000;
  var VERIFIED_PREFIX = 'sessionVerified_';

  function markVerified(code) {
    try {
      sessionStorage.setItem(VERIFIED_PREFIX + String(code).toUpperCase(), String(Date.now()));
    } catch (e) {}
  }

  function wasRecentlyVerified(code, maxAgeMs) {
    maxAgeMs = maxAgeMs == null ? 120000 : maxAgeMs;
    try {
      var raw = sessionStorage.getItem(VERIFIED_PREFIX + String(code).toUpperCase());
      if (!raw) return false;
      var t = parseInt(raw, 10);
      return !isNaN(t) && (Date.now() - t) < maxAgeMs;
    } catch (e) {
      return false;
    }
  }

  function clearVerified(code) {
    try {
      sessionStorage.removeItem(VERIFIED_PREFIX + String(code).toUpperCase());
    } catch (e) {}
  }

  function redirectToJoin(message) {
    var url = '/lab';
    if (global.LabPaths && typeof LabPaths.labUrl === 'function') {
      url = LabPaths.labUrl('index');
    } else if (global.LAB_STATIC_MODE && global.LAB_BASE_PATH) {
      url = String(global.LAB_BASE_PATH).replace(/\/+$/, '') + '/lab/index.html';
    }
    if (message) {
      url += (url.indexOf('?') >= 0 ? '&' : '?') + 'joinError=' + encodeURIComponent(message);
    }
    global.location.href = url;
  }

  /**
   * @param {string} joinCode
   * @param {{ timeoutMs?: number, role?: string }} [opts]
   * @returns {Promise<string>} resolved uppercase code
   */
  function probeActiveSession(joinCode, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || JOIN_PROBE_MS;

    return new Promise(function (resolve, reject) {
      if (!global.NetworkManager) {
        reject(new Error('Networking not loaded. Refresh the page and try again.'));
        return;
      }

      var code = String(joinCode || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(code)) {
        reject(new Error('Enter a valid session code from your instructor.'));
        return;
      }

      var net = new NetworkManager('admin-relay');
      var settled = false;
      var probeId = 'probe-' + Date.now().toString(36);

      function finish(ok, err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { net.disconnect(); } catch (e) {}
        if (ok) {
          markVerified(code);
          resolve(code);
        } else {
          reject(err || new Error('Session not found'));
        }
      }

      function onHubSignal(msg) {
        if (!msg) return;
        if (msg.isAdmin || msg.role === 'admin' || msg.type === 'admin-presence' ||
            msg.type === 'initial-state' ||
            (msg.type === 'peer-hello' && msg.isAdmin)) {
          finish(true);
        }
      }

      net.on('admin-presence', onHubSignal);
      net.on('initial-state', onHubSignal);
      net.on('peer-hello', onHubSignal);

      var timer = setTimeout(function () {
        finish(false, new Error(
          'No active session for code ' + code + '. Check the code, and make sure the instructor created the session and left their admin tab open.'
        ));
      }, timeoutMs);

      net.joinRoom(code, probeId, opts.role || 'miner').then(function () {
        net.send('request-state', { from: probeId });
      }).catch(function (err) {
        finish(false, err || new Error('Could not reach the session network.'));
      });
    });
  }

  /**
   * Gate a miner/wallet page: if the hub never answers, kick back to landing.
   * Soft timeout is stricter when the code was never verified on the landing page.
   */
  function requireActiveSession(joinCode, opts) {
    opts = opts || {};
    var code = String(joinCode || '').trim().toUpperCase();
    var softMs = opts.softTimeoutMs || 10000;
    var hardMs = opts.hardTimeoutMs || 20000;
    var recentlyOk = wasRecentlyVerified(code);
    var doRedirect = opts.redirect !== false;

    return new Promise(function (resolve, reject) {
      if (!/^[A-Z0-9]{4,8}$/.test(code)) {
        var bad = new Error('Invalid session code.');
        clearVerified(code);
        if (doRedirect) redirectToJoin(bad.message);
        reject(bad);
        return;
      }

      var hubSeen = false;

      function fail(err) {
        if (hubSeen) return;
        hubSeen = true; // prevent double settle
        clearVerified(code);
        if (global.__labSessionGate) global.__labSessionGate = null;
        if (doRedirect) redirectToJoin(err.message);
        reject(err);
      }

      function markHub() {
        if (hubSeen) return;
        hubSeen = true;
        clearTimeout(softTimer);
        clearTimeout(hardTimer);
        markVerified(code);
        if (global.__labSessionGate) global.__labSessionGate = null;
        resolve(code);
      }

      var softTimer = setTimeout(function () {
        if (hubSeen) return;
        if (!recentlyOk) {
          fail(new Error(
            'No active session for code ' + code + '. Ask your instructor for the current code.'
          ));
        }
      }, softMs);

      var hardTimer = setTimeout(function () {
        if (hubSeen) return;
        fail(new Error(
          'Could not reach the instructor hub for ' + code + '. Keep the admin tab open and try again.'
        ));
      }, hardMs);

      global.__labSessionGate = { code: code, markHub: markHub };
    });
  }

  function notifyHubSeen() {
    if (global.__labSessionGate && typeof global.__labSessionGate.markHub === 'function') {
      global.__labSessionGate.markHub();
    }
  }

  global.LabSessionProbe = {
    probeActiveSession: probeActiveSession,
    requireActiveSession: requireActiveSession,
    notifyHubSeen: notifyHubSeen,
    markVerified: markVerified,
    wasRecentlyVerified: wasRecentlyVerified,
    redirectToJoin: redirectToJoin
  };
})(typeof window !== 'undefined' ? window : this);
