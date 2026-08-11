/**
 * Blockchain Lab Landing Page
 *
 * Creates/joins client-side sessions. Default mode is Admin-hosted WebRTC relay.
 * Join requires a live instructor hub for the entered code.
 */

$(document).ready(function () {
  function go(page, code) {
    if (window.LabPaths && typeof LabPaths.labUrl === 'function') {
      window.location.href = LabPaths.labUrl(page, code);
    } else {
      window.location.href = '/lab/' + page + '/' + code;
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

  $('#createSessionBtn').click(function () {
    const mode = 'admin-relay';
    const net = new NetworkManager(mode);
    const $btn = $('#createSessionBtn');
    $btn.prop('disabled', true).text('Creating…');

    net.createRoom().then(function (roomCode) {
      localStorage.setItem('networkingMode_' + roomCode, mode);
      localStorage.setItem('joinCode_' + roomCode, roomCode);
      localStorage.setItem('isAdmin_' + roomCode, 'true');
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

    LabSessionProbe.probeActiveSession(joinCode, {
      onProgress: function (msg) {
        showJoinProgress(msg);
        $btn.text('Finding instructor…');
      }
    }).then(function (code) {
      localStorage.setItem('joinCode_' + code, code);
      localStorage.setItem('userId_' + code, 'user-' + Date.now().toString(36));
      localStorage.setItem('networkingMode_' + code, 'admin-relay');
      go(role === 'wallet' ? 'observe' : 'participate', code);
    }).catch(function (err) {
      console.warn('[Join] probe failed', err);
      showJoinError(err && err.message ? err.message : 'Invalid or inactive session code.');
      $btn.prop('disabled', false).text(originalText);
    });
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
