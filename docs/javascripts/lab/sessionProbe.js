/**
 * Verify a session code against a live instructor hub before joining.
 * Cross-device (phone QR) requires WebRTC via public trackers — allow a long wait.
 */
(function (global) {
  var JOIN_PROBE_MS = 25000;
  var VERIFIED_PREFIX = 'sessionVerified_';

  function markVerified(code) {
    try {
      sessionStorage.setItem(VERIFIED_PREFIX + String(code).toUpperCase(), String(Date.now()));
    } catch (e) {}
  }

  function wasRecentlyVerified(code, maxAgeMs) {
    maxAgeMs = maxAgeMs == null ? 180000 : maxAgeMs;
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

  function unreachableMessage(code) {
    return (
      'Could not reach the instructor hub for code ' + code + '. ' +
      'Phones need the instructor on the public lab URL (GitHub Pages), not localhost, with the admin tab left open. ' +
      'Same Wi‑Fi helps. Then tap Join again.'
    );
  }

  /**
   * @param {string} joinCode
   * @param {{ timeoutMs?: number, role?: string, onProgress?: function }} [opts]
   * @returns {Promise<string>} resolved uppercase code
   */
  function probeActiveSession(joinCode, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || JOIN_PROBE_MS;
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};

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
      var sawPeer = false;
      var retryTimer = null;
      var progressTimer = null;
      var startedAt = Date.now();

      function cleanupTimers() {
        clearTimeout(timer);
        if (retryTimer) clearInterval(retryTimer);
        if (progressTimer) clearInterval(progressTimer);
      }

      function finish(ok, err) {
        if (settled) return;
        settled = true;
        cleanupTimers();
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

      function pingHub() {
        try {
          net.send('request-state', { from: probeId });
          net.send('peer-joined', { role: 'miner' });
        } catch (e) {}
      }

      net.on('admin-presence', onHubSignal);
      net.on('initial-state', onHubSignal);
      net.on('peer-hello', onHubSignal);
      net.on('peer-count', function (msg) {
        var count = msg && msg.count != null ? msg.count : net.getPeerCount();
        if (count > 0) {
          sawPeer = true;
          onProgress('Found a peer — confirming instructor hub…');
          pingHub();
        }
      });

      var timer = setTimeout(function () {
        finish(false, new Error(
          sawPeer
            ? ('Found devices for ' + code + ' but the instructor hub did not answer in time. Keep the admin tab open and try again.')
            : unreachableMessage(code)
        ));
      }, timeoutMs);

      progressTimer = setInterval(function () {
        var secs = Math.floor((Date.now() - startedAt) / 1000);
        if (sawPeer) {
          onProgress('Connected to a peer — waiting for instructor confirmation… (' + secs + 's)');
        } else {
          onProgress('Searching for instructor hub over the network… (' + secs + 's)');
        }
      }, 1000);

      onProgress('Connecting…');

      net.joinRoom(code, probeId, opts.role || 'miner').then(function () {
        onProgress('Looking for the instructor’s open admin tab…');
        pingHub();
        // Keep pinging — WebRTC often connects a few seconds after joinRoom resolves
        retryTimer = setInterval(function () {
          pingHub();
          if (net.transport && net.transport.p2pt && typeof net.transport.p2pt.requestMorePeers === 'function') {
            net.transport.p2pt.requestMorePeers().catch(function () {});
          }
        }, 2500);
      }).catch(function (err) {
        finish(false, err || new Error('Could not reach the session network.'));
      });
    });
  }

  /**
   * Gate a miner/wallet page: if the hub never answers, kick back to landing.
   */
  function requireActiveSession(joinCode, opts) {
    opts = opts || {};
    var code = String(joinCode || '').trim().toUpperCase();
    var softMs = opts.softTimeoutMs || 20000;
    var hardMs = opts.hardTimeoutMs || 45000;
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
        hubSeen = true;
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
          fail(new Error(unreachableMessage(code)));
        }
      }, softMs);

      var hardTimer = setTimeout(function () {
        if (hubSeen) return;
        fail(new Error(unreachableMessage(code)));
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
    redirectToJoin: redirectToJoin,
    unreachableMessage: unreachableMessage
  };
})(typeof window !== 'undefined' ? window : this);
