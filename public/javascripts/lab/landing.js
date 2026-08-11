/**
 * Blockchain Lab Landing Page
 *
 * Creates/joins client-side sessions. Default mode is Admin-hosted WebRTC relay.
 */

$(document).ready(function () {
  function go(page, code) {
    if (window.LabPaths && typeof LabPaths.labUrl === 'function') {
      window.location.href = LabPaths.labUrl(page, code);
    } else {
      window.location.href = '/lab/' + page + '/' + code;
    }
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
      // Keep transport alive briefly then navigate — admin page re-inits as hub
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

    const joinCode = $('#joinCode').val().trim().toUpperCase();
    const rawRole = $('#roleSelect').val();

    let role = rawRole;
    if (rawRole === 'observer') role = 'wallet';
    if (rawRole === 'participant') role = 'miner';

    const targetSession = joinCode;
    localStorage.setItem('joinCode_' + targetSession, joinCode);
    localStorage.setItem('userId_' + targetSession, 'user-' + Date.now().toString(36));
    localStorage.setItem('networkingMode_' + targetSession, 'admin-relay');

    go(role === 'wallet' ? 'observe' : 'participate', targetSession);
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
    var $studentPanel = $('#joinForm').closest('.panel');
    if ($studentPanel.length) {
      $studentPanel.addClass('panel-success');
      $studentPanel.find('.panel-heading .panel-title').text('Student — session ' + code);
    }
    $('html, body').animate({ scrollTop: $('#joinForm').offset().top - 80 }, 300);
    $('#roleSelect').focus();
  })();
});
