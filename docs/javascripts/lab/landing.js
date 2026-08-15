/**
 * Blockchain Lab Landing Page
 *
 * Creates/joins client-side sessions. Default mode is Admin-hosted WebRTC relay.
 * Join requires a live instructor hub for the entered code.
 */

$(document).ready(function () {
  var chainFlavor = (window.LabPaths && LabPaths.getChainFlavor)
    ? LabPaths.getChainFlavor()
    : 'classic';
  if (window.LabPaths && typeof LabPaths.applyClassroomTheme === 'function') {
    LabPaths.applyClassroomTheme();
  }

  function go(page, code, uid) {
    if (window.LabPaths && typeof LabPaths.labUrl === 'function') {
      window.location.href = LabPaths.labUrl(page, code, uid ? { uid: uid } : {});
    } else {
      var url = '/lab/' + page + '/' + code;
      if (uid) url += '?uid=' + encodeURIComponent(uid);
      window.location.href = url;
    }
  }

  function showJoinError(message) {
    var $err = $('#joinError');
    if (!$err.length) {
      $('#joinForm').prepend(
        '<div id="joinError" class="alert alert-danger" style="display:none; margin-bottom:12px;"></div>'
      );
      $err = $('#joinError');
    }
    $err.removeClass('alert-info').addClass('alert-danger').text(message).show();
  }

  function showJoinProgress(message) {
    var $err = $('#joinError');
    if (!$err.length) {
      $('#joinForm').prepend(
        '<div id="joinError" class="alert alert-info" style="display:none; margin-bottom:12px;"></div>'
      );
      $err = $('#joinError');
    }
    $err.removeClass('alert-danger').addClass('alert-info').text(message).show();
  }

  function hideJoinError() {
    $('#joinError').hide().text('').removeClass('alert-info').addClass('alert-danger');
  }

  var joinAttempt = { cancelled: false, abort: null };

  function joinButtonLabel() {
    return $('#roleSelect').val() === 'observer' ? 'Join as Wallet' : 'Join as Miner';
  }

  function resetJoinButton($btn, text) {
    $btn.prop('disabled', false).text(text || joinButtonLabel());
    $('#joinCancelBtn').hide();
  }

  function abortJoinProbe() {
    joinAttempt.cancelled = true;
    if (typeof joinAttempt.abort === 'function') {
      try { joinAttempt.abort(); } catch (e) {}
    }
    joinAttempt.abort = null;
  }

  $('#createSessionBtn').click(function () {
    const mode = 'admin-relay';
    const net = new NetworkManager(mode);
    const $btn = $('#createSessionBtn');
    $btn.prop('disabled', true).text('Creating…');

    net.createRoom().then(function (roomCode) {
      roomCode = String(roomCode || '').toUpperCase();
      // A new Create must never reopen leftover state from a previous unused code
      // (toast "Session restored from previous tab session" hijacked CVV1U8 → 91G5M2).
      if (window.Persistence && typeof Persistence.markFreshAdminCreate === 'function') {
        Persistence.markFreshAdminCreate(roomCode);
      } else {
        try { sessionStorage.setItem('labAdminFreshCreate_' + roomCode, '1'); } catch (e2) {}
        try { localStorage.removeItem('blockchain-lab-admin-' + roomCode); } catch (e3) {}
      }
      // This tab is the live hub from the moment Create succeeds — never
      // toast "Session restored" while it stays open (XU1J1S mid-watch).
      if (window.Persistence && typeof Persistence.markLiveAdminHub === 'function') {
        Persistence.markLiveAdminHub(roomCode);
      } else {
        try { sessionStorage.setItem('labAdminLiveHub_' + roomCode, '1'); } catch (e4) {}
      }
      localStorage.setItem('networkingMode_' + roomCode, mode);
      localStorage.setItem('joinCode_' + roomCode, roomCode);
      localStorage.setItem('isAdmin_' + roomCode, 'true');
      if (window.LabPaths && LabPaths.persistChainFlavor) {
        LabPaths.persistChainFlavor(roomCode, chainFlavor);
      } else {
        localStorage.setItem('chainFlavor_' + roomCode, chainFlavor);
      }
      if (net.userId) {
        localStorage.setItem('adminUserId_' + roomCode, net.userId);
      }
      try { net.disconnect(); } catch (e) {}
      go('admin', roomCode);
    }).catch(function (err) {
      console.error(err);
      $btn.prop('disabled', false).text('Create Session');
      alert('Could not create session: ' + (err && err.message ? err.message : err));
    });
  });

  $('#joinForm').submit(function (e) {
    e.preventDefault();
    hideJoinError();

    const joinCode = $('#joinCode').val().trim().toUpperCase();
    const rawRole = $('#roleSelect').val();
    const $btn = $('#joinForm button[type="submit"]');
    const originalText = $btn.text();

    let role = rawRole;
    if (rawRole === 'observer') role = 'wallet';
    if (rawRole === 'participant') role = 'miner';

    if (!joinCode) {
      showJoinError('Enter the session code from your instructor.');
      return;
    }

    if (!window.LabSessionProbe || typeof LabSessionProbe.probeActiveSession !== 'function') {
      showJoinError('Join checker not loaded. Refresh the page and try again.');
      return;
    }

    $btn.prop('disabled', true).text('Finding instructor…');
    $('#joinCancelBtn').show();
    joinAttempt = { cancelled: false, abort: null };

    LabSessionProbe.probeActiveSession(joinCode, {
      timeoutMs: 10000,
      handle: joinAttempt,
      onAbort: function (fn) { joinAttempt.abort = fn; },
      onProgress: function (msg) {
        if (joinAttempt.cancelled) return;
        showJoinProgress(msg);
        $btn.text('Finding instructor…');
      },
      shouldAbort: function () {
        return !!joinAttempt.cancelled;
      }
    }).then(function (code) {
      if (joinAttempt.cancelled) return;
      localStorage.setItem('joinCode_' + code, code);
      // Always mint a new id (Open Test Miner Tab pattern). A second Join on
      // the same origin must not adopt localStorage userId_SESSION_wallet.
      var tabId = (window.LabPaths && typeof LabPaths.mintJoinUserId === 'function')
        ? LabPaths.mintJoinUserId(code, role)
        : ('user_' + Math.random().toString(36).substr(2, 9));
      try { sessionStorage.setItem('labUserId_' + code, tabId); } catch (e2) {}
      if (window.LabPaths && LabPaths.persistNodeRole) {
        LabPaths.persistNodeRole(code, tabId, role);
      }
      localStorage.setItem('networkingMode_' + code, 'admin-relay');
      if (window.LabPaths && LabPaths.persistChainFlavor) {
        LabPaths.persistChainFlavor(code, chainFlavor);
      }
      go(role === 'wallet' ? 'observe' : 'participate', code, tabId);
    }).catch(function (err) {
      if (joinAttempt.cancelled || (err && err.cancelled)) {
        hideJoinError();
        resetJoinButton($btn, originalText);
        return;
      }
      console.warn('[Join] probe failed', err);
      showJoinError(err && err.message ? err.message : 'Invalid or inactive session code. Check the code and try again.');
      resetJoinButton($btn, originalText);
    });
  });

  $('#joinCancelBtn').on('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    abortJoinProbe();
    hideJoinError();
    resetJoinButton($('#joinForm button[type="submit"]'));
  });

  $('#roleSelect').change(function () {
    const role = $(this).val();
    const $btn = $('#joinForm button[type="submit"]');
    $btn.text(role === 'observer' ? 'Join as Wallet' : 'Join as Miner');
  });

  (function setInitialJoinButton() {
    const role = $('#roleSelect').val();
    const $btn = $('#joinForm button[type="submit"]');
    $btn.text(role === 'observer' ? 'Join as Wallet' : 'Join as Miner');
  })();

  // Prefill from ?join= / ?session= / ?code= (QR + share links)
  (function prefillJoinFromQuery() {
    var code = (window.LabPaths && LabPaths.getSessionIdFromLocation)
      ? LabPaths.getSessionIdFromLocation()
      : '';
    if (!code) {
      try {
        var params = new URLSearchParams(window.location.search || '');
        code = (params.get('join') || params.get('session') || params.get('code') || '').trim().toUpperCase();
      } catch (e) {}
    }
    if (!code) return;
    $('#joinCode').val(code);
    var $studentPanel = $('#joinForm').closest('.lab-action--student');
    if ($studentPanel.length) {
      $studentPanel.find('h2').text('Student — ' + code);
    }
    $('html, body').animate({ scrollTop: $('#joinForm').offset().top - 80 }, 300);
    $('#roleSelect').focus();
  })();

  // Show error passed back from participate/observe gate
  (function showRedirectedJoinError() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      var msg = params.get('joinError');
      if (msg) showJoinError(msg);
    } catch (e) {}
  })();
});
