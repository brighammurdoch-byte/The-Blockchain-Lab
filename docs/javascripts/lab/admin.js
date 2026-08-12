/**
 * Blockchain Lab Admin Dashboard
 * Client-side only (Admin Relay mode).
 * The browser maintains the canonical chain and coordinates participants.
 */

let sessionId = null;
let initialSettingsLoaded = false;
let openTxPanels = new Set();
let networkViz = null; // Network visualization instance

// Client-side networking
let networkMode = null;
let net = null;
let coordinator = null;
let relayState = null;
let socket = null; // legacy stub

// Toast notification function (non-intrusive bubble at top)
function showToastNotification(message, type = 'info') {
  // Remove existing toast if any
  $('#toastNotification').remove();
  
  const bgColor = type === 'success' ? '#28a745' : type === 'error' ? '#dc3545' : '#17a2b8';
  
  const toast = $(`
    <div id="toastNotification" style="
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${bgColor};
      color: white;
      padding: 15px 25px;
      border-radius: 5px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.2);
      z-index: 9999;
      max-width: 400px;
      word-wrap: break-word;
      animation: slideIn 0.3s ease-out;
    ">
      ${message}
    </div>
  `);
  
  $('body').append(toast);
  
  // Auto-dismiss after 4 seconds
  setTimeout(function() {
    toast.fadeOut(300, function() { $(this).remove(); });
  }, 4000);
}

// Add CSS animation for toast
if (!$('#toastStyles').length) {
  $('<style id="toastStyles">@keyframes slideIn { from { transform: translateX(450px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }</style>').appendTo('head');
}

$(document).ready(function() {
  // Extract sessionId from URL (path or ?session= for static hosting)
  sessionId = (window.LabPaths && LabPaths.getSessionIdFromLocation()) || window.location.pathname.split('/').pop();

  // Display session code (from storage or the one passed from server/URL)
  const joinCode = localStorage.getItem('joinCode_' + sessionId) || sessionId;
  $('#sessionCode').text(joinCode);
  renderJoinShareCard(joinCode);
  $('#sessionCode').after('<span style="display: block; margin-top: 10px; text-align: center;"><strong>Your Role: </strong><span class="label label-danger" style="font-size: 1em;">Admin</span></span>');

  // Client-relay badge
  $('#sessionCode').after(
    `<span style="display:block; margin-top:6px; text-align:center;">
       <span class="label label-success" style="font-size:0.9em;" id="networkModeBadge">Admin-hosted (cloud relay)</span>
     </span>`
  );
  console.log('[BlockchainLab] Client-relay mode active for room:', sessionId);

  networkMode = localStorage.getItem('networkingMode_' + (joinCode || sessionId)) || 'admin-relay';
  if ($('#networkModeSelect').length) {
    $('#networkModeSelect').val(networkMode === 'p2p' ? 'p2p' : 'admin-relay');
  }

  // Initialize client-relay networking
  initClientSideNetworking(networkMode, joinCode || sessionId);

  // Initialize Network Visualization
  try {
    if (typeof NetworkVisualization === 'function' && typeof d3 !== 'undefined') {
      networkViz = new NetworkVisualization('#networkVisualizationSvg');
      window.networkViz = networkViz;
    } else {
      console.warn('[Viz] D3 or NetworkVisualization missing — topology disabled');
    }
  } catch (e) {
    console.warn('[Viz] Failed to init topology:', e && e.message);
  }

  // Render from local relayed state
  if (typeof renderClientRelayChain === 'function') {
    setTimeout(() => {
      renderClientRelayChain();
      if (typeof renderClientParticipants === 'function') renderClientParticipants();
    }, 80);
  } else {
    $('#blockchainView').html('<p class="text-muted">Client-relay mode active.</p>');
  }

  // Set up event handlers
  setupEventHandlers();

  // Periodically rewire P2P gossip edges (Bitcoin-style peer churn)
  setInterval(function () {
    const mode = typeof resolveVizNetworkMode === 'function'
      ? resolveVizNetworkMode()
      : networkMode;
    if (mode !== 'p2p' && mode !== 'mesh') return;
    if (!relayState) return;
    window.__forceGossipRewire = true;
    if (typeof renderClientRelayChain === 'function') {
      renderClientRelayChain({ forceTopologyRelayout: true, forceGossipRewire: true });
    }
  }, 16000);
});

/** Share link + QR for student join (phones scan; laptops copy URL). */
function renderJoinShareCard(roomCode) {
  const code = String(roomCode || '').toUpperCase();
  if (!code) return;

  let url = '';
  if (window.LabPaths && typeof LabPaths.absoluteJoinUrl === 'function') {
    url = LabPaths.absoluteJoinUrl(code);
  } else {
    url = window.location.origin + '/lab?join=' + encodeURIComponent(code);
  }

  $('#joinShareLink').val(url);

  // Phones cannot join a localhost / private-IP hub — QR must point at the public Pages URL
  var host = '';
  try { host = new URL(url).hostname; } catch (e) { host = window.location.hostname || ''; }
  var isLocalHub = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(host) ||
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host);
  $('#joinLocalhostWarn').remove();
  if (isLocalHub) {
    $('#joinShareLink').closest('p, .form-group, .input-group').first().parent().append(
      '<div id="joinLocalhostWarn" class="alert alert-danger" style="margin-top:12px; text-align:left;">' +
      '<strong>Phones cannot use this QR.</strong> This admin page is on <code>' + host + '</code>. ' +
      'Open the lab on <strong>GitHub Pages</strong> first, create the session there, then scan that QR. ' +
      'Keep that Pages admin tab open.</div>'
    );
    $('#joinQrLabel').text('QR is localhost — phones will fail');
  } else {
    $('#joinQrLabel').text('Scan to join (phones)');
  }

  $('#copyJoinLinkBtn').off('click').on('click', function () {
    const link = $('#joinShareLink').val();
    const done = function () {
      showToastNotification('Join link copied — paste into chat or email', 'success');
      $('#copyJoinLinkBtn').text('Copied!');
      setTimeout(function () { $('#copyJoinLinkBtn').text('Copy'); }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done).catch(function () {
        $('#joinShareLink').select();
        try { document.execCommand('copy'); done(); } catch (e) {
          showToastNotification('Select the link and copy manually (Ctrl+C)', 'info');
        }
      });
    } else {
      $('#joinShareLink').select();
      try { document.execCommand('copy'); done(); } catch (e) {
        showToastNotification('Select the link and copy manually (Ctrl+C)', 'info');
      }
    }
  });

  const canvas = document.getElementById('joinQrCanvas');
  if (!canvas) return;

  function getQrApi() {
    var api = window.QRCode || window.qrcode;
    if (typeof api === 'function' && api.toCanvas) return api;
    if (api && typeof api.toCanvas === 'function') return api;
    if (api && api.default && typeof api.default.toCanvas === 'function') return api.default;
    return null;
  }

  function drawFallbackText(msg) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#5c7380';
    ctx.font = '12px sans-serif';
    ctx.fillText(msg || 'Use the share link', 28, 90);
  }

  function drawQr() {
    var api = getQrApi();
    if (!api) {
      drawFallbackText('QR unavailable');
      console.warn('[Admin] QRCode library missing');
      return;
    }
    api.toCanvas(canvas, url, {
      width: 180,
      margin: 2,
      color: { dark: '#0f1c24', light: '#ffffff' }
    }, function (err) {
      if (err) {
        console.warn('[Admin] QR render failed', err);
        drawFallbackText('QR failed — use link');
        showToastNotification('Could not draw QR code — use the share link instead', 'error');
      }
    });
  }

  if (getQrApi()) {
    drawQr();
  } else {
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (getQrApi() || tries > 50) {
        clearInterval(timer);
        drawQr();
      }
    }, 50);
  }
}

// Client-relay networking initialization (the only mode now)
function initClientSideNetworking(mode, roomCode) {
  if (!window.NetworkManager) {
    console.error('[ClientNet] NetworkManager not loaded.');
    return;
  }

  net = new NetworkManager(mode);

  // Re-hydrate as admin using the original userId from landing when available (better for refresh + relay logic)
  const storedAdminUserId = localStorage.getItem('adminUserId_' + roomCode);
  const adminUserId = storedAdminUserId || ('admin-' + roomCode);

  // Directly attach to the same transport channel without calling the full createRoom flow
  net.isAdmin = true;
  net.role = 'admin';
  net.userId = adminUserId;
  net.roomCode = roomCode;

  // Persist for refresh survival
  localStorage.setItem('adminUserId_' + roomCode, adminUserId);

  if (net.transport && typeof net.transport.initAsAdmin === 'function') {
    net.transport.initAsAdmin(roomCode, adminUserId).then(() => {
      console.log('[ClientNet] Admin relay transport initialized for room:', roomCode, 'mode:', mode);

      // Only announce after MQTT/BroadcastChannel are actually up (critical for phone QR joins)
      net.send('admin-presence', { roomCode: roomCode, adminUserId: adminUserId });
      if (relayState) {
        const state = relayState.getSanitizedStateForNewPeer();
        net.send('initial-state', state);
        console.log('[ClientNet] Broadcast initial state after transport ready');
      }
      if (typeof renderClientRelayChain === 'function') {
        renderClientRelayChain();
      }
    }).catch((err) => {
      console.error('[ClientNet] initAsAdmin failed', err);
      showToastNotification('Network hub failed to start — refresh the admin tab', 'error');
    });
  } else {
    console.warn('[ClientNet] Transport does not support initAsAdmin; messages may not flow.');
  }

  // === Real blockchain state for this admin-relay room ===
  if (window.RelayBlockchainState) {
    relayState = new RelayBlockchainState(roomCode);
    window.relayState = relayState; // projector + audits
    relayState.ensureGenesis();

    // Try to restore previous session (admin refresh survival)
    const restored = Persistence.loadAdminState(roomCode);
    if (restored) {
      const success = relayState.restoreFromPersisted(restored);
      if (success) {
        console.log('[ClientNet] Restored previous session state from localStorage');
        showToastNotification('Session restored from previous tab session', 'success');

        // Re-apply restored settings to the UI sliders
        if (restored.settings) {
          $('#difficultyLeading').val(restored.settings.difficultyLeading != null ? restored.settings.difficultyLeading : 1);
          $('#difficultySecondary').val(restored.settings.difficultySecondary != null ? restored.settings.difficultySecondary : 8);
          $('#miningReward').val(restored.settings.miningRewardCoins || 10);
          if (restored.settings.targetBlockTimeSec != null) {
            $('#targetBlockTimeSec').val(restored.settings.targetBlockTimeSec);
          }
          if (typeof restored.settings.autoDifficulty === 'boolean') {
            $('#autoDifficulty').prop('checked', restored.settings.autoDifficulty);
          }
          $('#lockParameters').prop('checked', !!restored.settings.parametersLocked);
          updateDifficultyDisplay();
          updateSettingsDisplay(restored.settings);
          applyAutoDifficultyUI();
        }
        if (relayState.networkPaused) {
          $('#toggleNetworkBtn').text('Resume Network').data('paused', true);
          if (net && net.transport) net.transport.networkPaused = true;
        }
        if (restored.settings) {
          applyParameterLockUI(!!restored.settings.parametersLocked);
        }
      }
    }

    // Apply any current slider values as initial settings (if no restore)
    const initialSettings = {
      difficultyLeading: parseInt($('#difficultyLeading').val(), 10) || 1,
      difficultySecondary: (function () {
        var s = parseInt($('#difficultySecondary').val(), 10);
        return isNaN(s) ? 8 : s;
      })(),
      miningRewardCoins: parseInt($('#miningReward').val(), 10) || 10,
      parametersLocked: $('#lockParameters').is(':checked'),
      targetBlockTimeSec: parseInt($('#targetBlockTimeSec').val(), 10) || 10,
      autoDifficulty: $('#autoDifficulty').length ? $('#autoDifficulty').is(':checked') : true
    };
    relayState.updateSettings(initialSettings);

    // Ensure admin registers itself so lists + viz show the hub from the start (educational).
    // Endowment gives the instructor starter coins to fund student wallets without mining.
    if (relayState && typeof relayState.addOrUpdateParticipant === 'function') {
      const existing = relayState.participants.get(adminUserId);
      const endow = (existing && existing.endowment != null) ? existing.endowment : 100;
      relayState.addOrUpdateParticipant(adminUserId, 'admin', {
        displayName: (existing && (existing.displayName || existing.name)) || 'Admin (Hub)',
        hashrate: 0,
        status: 'idle',
        endowment: endow
      });
      // Apply endowment into displayed balance (recompute may not run until first block)
      if (typeof relayState._recomputeMiningRewards === 'function') {
        relayState._recomputeMiningRewards();
      } else {
        const p = relayState.participants.get(adminUserId);
        if (p && (Number(p.balance) || 0) === 0 && endow > 0) p.balance = endow;
      }
    }

    // Show address immediately (wallet panel)
    $('#yourAddress').text(adminUserId);
    if (typeof updateAdminWalletUI === 'function') updateAdminWalletUI();

    // Render immediately now that state exists (at least genesis)
    if (typeof renderClientRelayChain === 'function') {
      renderClientRelayChain();
    }
  }

  // Wire up coordinator with the real state object
  if (window.AdminRelayCoordinator && relayState) {
    coordinator = new AdminRelayCoordinator(net, relayState);
    coordinator.startAutoSave(10000); // Auto-persist every 10s

    // Extra safety saves on important events
    const forceSave = () => {
      if (relayState && net && net.isAdmin && net.roomCode) {
        Persistence.saveAdminState(net.roomCode, relayState.getFullState());
      }
    };

    // Force save when page is about to unload (tab close / refresh)
    window.addEventListener('beforeunload', forceSave);

    // Also save on visibility change (user switches tabs)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) forceSave();
    });

    console.log('[ClientNet] AdminRelayCoordinator + RelayBlockchainState attached (with strong persistence)');

    // When auto-difficulty retargets, keep admin sliders + badge in sync
    coordinator.onDifficultyRetarget = function (settings) {
      if (!settings) return;
      if (settings.difficultyLeading != null) {
        $('#difficultyLeading').val(settings.difficultyLeading);
      }
      if (settings.difficultySecondary != null) {
        $('#difficultySecondary').val(settings.difficultySecondary);
      }
      updateDifficultyDisplay();
      refreshBlockPaceDisplay();
      // Soft toast so instructor sees pacing is working (debounced)
      if (!window.__lastRetargetToast || Date.now() - window.__lastRetargetToast > 8000) {
        window.__lastRetargetToast = Date.now();
        const t = settings.targetBlockTimeSec || 10;
        showToastNotification(
          'Difficulty auto-adjusted toward ~' + t + 's blocks (now ' +
          settings.difficultyLeading + ' + 0x' +
          Number(settings.difficultySecondary).toString(16).toUpperCase() + ')',
          'info'
        );
      }
    };
  }

  // Presence + initial-state are sent after initAsAdmin resolves (see above)

  // Miner hard-fork votes → show on projector
  net.on('hard-fork-vote', (msg) => {
    const payload = msg.payload || msg;
    const uid = msg.from || payload.userId;
    const choice = payload.choice || 'classic';
    if (relayState && uid) {
      relayState.addOrUpdateParticipant(uid, 'miner', { forkChoice: choice });
      if (typeof renderClientParticipants === 'function') renderClientParticipants();
    }
  });

  // Listen for high-level events (coordinator handles most now)
  net.on('peer-joined', (msg) => {
    if (msg.from && String(msg.from).indexOf('probe-') === 0) {
      // Landing-page session probe — answer state but don't clutter UI
      return;
    }
    console.log('[ClientNet] Peer joined relay:', msg.from, msg.role);
    showToastNotification(`Miner joined: ${msg.from}`, 'info');

    if (relayState) {
      const role = msg.role || 'miner';
      const r = String(role).toLowerCase();
      const extra = (r === 'wallet' || r === 'observer') ? { endowment: 100 } : {};
      relayState.addOrUpdateParticipant(msg.from, role, extra);
      if (typeof relayState._recomputeMiningRewards === 'function') {
        relayState._recomputeMiningRewards();
      }
    }
    if (typeof renderClientParticipants === 'function') {
      renderClientParticipants();
    }
    if (typeof renderClientRelayChain === 'function') {
      renderClientRelayChain(); // refreshes chain + viz + stats too
    }
    // Push roster so existing miners/wallets can see the new address immediately
    if (relayState && net) {
      try {
        net.send('participants-roster', {
          participants: Array.from(relayState.participants.values())
        });
      } catch (e) {}
    }
  });

  net.on('admin-settings-updated', (msg) => {
    console.log('[ClientNet] Settings update received on admin:', msg);
  });

  // Re-render our own view when we (or the coordinator) accept a new block
  net.on('block-accepted', (msg) => {
    const payload = msg.payload || msg;
    const block = payload.block;
    const minerId = payload.minerId || (block && block.miner) || msg.from;

    // Live topology: flash finder + send block packets along edges
    try {
      const viz = window.networkViz || networkViz;
      if (viz && minerId && minerId !== 'genesis') {
        if (typeof viz.animateBlockMined === 'function') viz.animateBlockMined(minerId);
        if (relayState && typeof viz.animateBlockPropagation === 'function') {
          // Prefer live topology neighbors (gossip/star); fall back to all peers
          let recipients = [];
          if (typeof viz.getNeighborIds === 'function') {
            recipients = viz.getNeighborIds(minerId);
          }
          if (!recipients.length) {
            recipients = Array.from(relayState.participants.keys())
              .filter(function (id) {
                return id && id !== minerId && String(id).indexOf('probe-') !== 0;
              });
          }
          viz.animateBlockPropagation(minerId, recipients, block || { index: payload.newHeight });
        }
        if (relayState && typeof relayState.setParticipantStatus === 'function') {
          relayState.setParticipantStatus(minerId, 'block-found');
          setTimeout(function () {
            const p = relayState.participants.get(minerId);
            const back = p && p.hashrate > 0 ? 'mining' : 'idle';
            relayState.setParticipantStatus(minerId, back);
          }, 1200);
        }
      }
    } catch (e) {}

    if (typeof scheduleRenderClientRelayChain === 'function') {
      scheduleRenderClientRelayChain();
    } else if (typeof renderClientRelayChain === 'function') {
      renderClientRelayChain();
    }
    // Debounced persistence — full chain writes every block freeze the admin UI
    if (relayState && net && net.roomCode && typeof schedulePersistAdminState === 'function') {
      schedulePersistAdminState();
    }
  });

  net.on('transaction-accepted', (msg) => {
    const payload = msg.payload || msg;
    const tx = payload.transaction || payload;
    const fromId = (tx && tx.from) || msg.from;

    // Animate tx packets along star paths
    try {
      const viz = window.networkViz || networkViz;
      if (viz && fromId && typeof viz.animateTransactionPropagation === 'function') {
        viz.animateTransactionPropagation(fromId, tx);
      }
    } catch (e) {}

    // Ensure hub state is current (coordinator already added); refresh projector lists
    if (typeof renderClientParticipants === 'function') renderClientParticipants();
    if (typeof scheduleRenderClientRelayChain === 'function') scheduleRenderClientRelayChain();
    else if (typeof renderClientRelayChain === 'function') renderClientRelayChain();

    const pending = (payload && Array.isArray(payload.pendingTransactions))
      ? payload.pendingTransactions
      : (relayState && Array.isArray(relayState.pendingTransactions)
        ? relayState.pendingTransactions
        : []);
    if (typeof updatePendingTransactions === 'function') {
      updatePendingTransactions({
        pendingTransactions: pending,
        participants: relayState
          ? Array.from(relayState.participants.values())
          : []
      });
    }
    const n = pending.length;
    showToastNotification('Transaction in mempool (' + n + ' pending)', 'info');
  });

  // Basic hashrate reporting (from test peers or future real participants)
  function nackMinerIfPaused(uid) {
    if (!relayState || !relayState.networkPaused || !net || !uid) return false;
    net.send('network-toggled', {
      paused: true,
      networkPaused: true,
      reason: 'hub-sync',
      seq: Date.now()
    }, uid);
    return true;
  }

  net.on('hashrate-report', (msg) => {
    const payload = msg.payload || msg;
    const uid = payload.userId || msg.from;
    const hashrate = payload.hashrate;
    if (nackMinerIfPaused(uid) && hashrate > 0) return;
    if (relayState && uid) {
      relayState.updateHashrate(uid, hashrate);
      if (typeof renderClientParticipants === 'function') renderClientParticipants();
      const viz = window.networkViz || networkViz;
      const p = relayState.participants.get(uid);
      if (viz && p && typeof viz.setNodeStatus === 'function') {
        viz.setNodeStatus(uid, p.status || 'idle');
      }
    }
  });
  net.on('hashrate-update', (msg) => {
    const payload = msg.payload || msg;
    const uid = payload.userId || msg.from;
    const hashrate = payload.hashrate;
    if (nackMinerIfPaused(uid) && hashrate > 0) return;
    if (relayState && uid) {
      relayState.updateHashrate(uid, hashrate);
      if (typeof renderClientParticipants === 'function') renderClientParticipants();
      const viz = window.networkViz || networkViz;
      const p = relayState.participants.get(uid);
      if (viz && p && typeof viz.setNodeStatus === 'function') {
        viz.setNodeStatus(uid, p.status || 'idle');
      }
    }
  });

  // Miner announced which tip they are hashing
  net.on('mining-on-block', (msg) => {
    const payload = msg.payload || msg;
    const uid = payload.minerAddress || payload.userId || msg.from;
    if (!uid || !relayState) return;

    // Phone missed the pause signal but is still hashing — force a pause nack
    if (relayState.networkPaused) {
      if (net) {
        net.send('network-toggled', {
          paused: true,
          networkPaused: true,
          reason: 'hub-sync',
          seq: Date.now()
        }, uid);
        // Also broadcast so all stragglers catch up
        net.send('network-toggled', {
          paused: true,
          networkPaused: true,
          reason: 'hub-sync-broadcast',
          seq: Date.now() + 1
        });
      }
      relayState.setParticipantStatus(uid, 'idle');
      if (typeof renderClientParticipants === 'function') renderClientParticipants();
      return;
    }

    relayState.addOrUpdateParticipant(uid, 'miner');
    relayState.setParticipantStatus(uid, 'mining');
    const viz = window.networkViz || networkViz;
    if (viz && typeof viz.setNodeStatus === 'function') {
      viz.setNodeStatus(uid, 'mining');
    }
    if (typeof renderClientParticipants === 'function') renderClientParticipants();
  });

  // Student display-name changes → topology + participant lists
  net.on('node-name-changed', (msg) => {
    const payload = msg.payload || msg;
    const uid = payload.userId || msg.from;
    const name = (payload.name != null ? String(payload.name) : '').trim();
    if (!uid || !relayState) return;

    const existing = relayState.participants.get(uid);
    const role = (existing && existing.role) || 'miner';
    relayState.addOrUpdateParticipant(uid, role, {
      name: name || null,
      displayName: name || null
    });

    const viz = window.networkViz || networkViz;
    if (viz && typeof viz.setNodeName === 'function' && name) {
      viz.setNodeName(uid, name);
    }
    if (typeof renderClientParticipants === 'function') renderClientParticipants();
    if (typeof renderClientRelayChain === 'function') renderClientRelayChain();

    // Echo so other peers' UIs can refresh names from initial-state / lists
    if (net && net.isAdmin) {
      try {
        net.send('participant-updated', {
          userId: uid,
          name: name,
          role: role
        });
        net.send('participants-roster', {
          participants: Array.from(relayState.participants.values())
        });
      } catch (e) {}
    }
  });

  net.on('peer-count', (msg) => {
    const count = (msg && msg.count != null) ? msg.count : (net.getPeerCount ? net.getPeerCount() : 0);
    $('#peerCountBadge').text('Peers: ' + count).removeClass('label-default label-warning').addClass(count > 0 ? 'label-success' : 'label-warning');
  });

  // In Full P2P mode, accept gossiped blocks locally as well (admin still tracks chain for projector)
  net.on('block-gossip', (msg) => {
    const block = (msg.payload && msg.payload.block) || msg.block;
    const minerId = (msg.payload && msg.payload.minerId) || msg.from;
    if (!block || !relayState) return;
    const result = relayState.tryAddBlock(block, minerId);
    if (result && result.accepted && !result.duplicate) {
      if (result.retargetSettings && coordinator) {
        coordinator.broadcastSettings(result.retargetSettings);
        if (typeof coordinator.onDifficultyRetarget === 'function') {
          coordinator.onDifficultyRetarget(result.retargetSettings);
        }
      } else if (result.retargetSettings && net) {
        net.send('admin-settings-updated', result.retargetSettings);
      }
      net.send('block-accepted', {
        block,
        minerId,
        isFork: !!result.isFork,
        reorg: !!result.reorg,
        tipChanged: !!result.tipChanged,
        newHeight: result.newHeight,
        chain: result.chain || relayState.chain.slice(),
        participants: Array.from(relayState.participants.values()),
        networkStats: { ...relayState.networkStats }
      });
      if (typeof renderClientRelayChain === 'function') renderClientRelayChain();
    }
  });

  // Handle explicit request for state from joiners (more reliable than relying only on peer-joined)
  net.on('request-state', (msg) => {
    const requester = msg.payload && msg.payload.from ? msg.payload.from : msg.from;
    if (relayState) {
      const state = relayState.getSanitizedStateForNewPeer();
      net.send('initial-state', state, requester);
      console.log('[ClientNet] Sent initial-state in response to request from', requester);
    }
  });

  // Expose for easy console-based multi-tab testing (open another tab, run similar code in console)
  window.BlockchainLabNet = net;
  window.BlockchainLabCoordinator = coordinator;
  window.relayState = relayState;
}

function setupEventHandlers() {
  // Difficulty sliders
  $('#difficultyLeading').on('input', function() {
    updateDifficultyDisplay();
  });
  
  $('#difficultySecondary').on('input', function() {
    updateDifficultyDisplay();
  });
  
  // Reflect current lock state on load / restore
  if (relayState && relayState.settings) {
    applyParameterLockUI(!!relayState.settings.parametersLocked);
  } else {
    applyParameterLockUI($('#lockParameters').is(':checked'));
  }
  applyAutoDifficultyUI();
  refreshBlockPaceDisplay();

  $('#lockParameters').on('change', function () {
    // Unchecking immediately re-enables controls; locking still requires Update Settings
    if (!$(this).is(':checked')) {
      applyParameterLockUI(false);
    }
  });

  $('#autoDifficulty').on('change', function () {
    applyAutoDifficultyUI();
  });

  // Update Settings Button
  $('#updateSettingsBtn').click(function() {
    const selectedMode = $('#networkModeSelect').val() || 'admin-relay';
    const wantLock = $('#lockParameters').is(':checked');
    const wasLocked = !!(relayState && relayState.settings && relayState.settings.parametersLocked);

    // While locked, only allow an unlock (uncheck + Update). Block other changes.
    if (wasLocked && wantLock) {
      showToastNotification('Parameters are locked — uncheck “Lock parameters” and click Update Settings to change them', 'warning');
      // Re-sync UI to frozen values
      if (relayState && relayState.settings) {
        const s = relayState.settings;
        $('#difficultyLeading').val(s.difficultyLeading);
        $('#difficultySecondary').val(s.difficultySecondary != null ? s.difficultySecondary : 8);
        $('#miningReward').val(s.miningRewardCoins || 10);
        if (s.targetBlockTimeSec != null) $('#targetBlockTimeSec').val(s.targetBlockTimeSec);
        if (typeof s.autoDifficulty === 'boolean') $('#autoDifficulty').prop('checked', s.autoDifficulty);
        $('#networkModeSelect').val(s.networkMode === 'p2p' ? 'p2p' : 'admin-relay');
        updateDifficultyDisplay();
        applyParameterLockUI(true);
        applyAutoDifficultyUI();
      }
      return;
    }

    const newSettings = {
      difficultyLeading: parseInt($('#difficultyLeading').val(), 10) || 1,
      difficultySecondary: (function () {
        var s = parseInt($('#difficultySecondary').val(), 10);
        return isNaN(s) ? 8 : s;
      })(),
      miningRewardCoins: parseInt($('#miningReward').val(), 10) || 10,
      networkMode: selectedMode,
      parametersLocked: wantLock,
      targetBlockTimeSec: parseInt($('#targetBlockTimeSec').val(), 10) || 10,
      autoDifficulty: $('#autoDifficulty').is(':checked')
    };

    networkMode = selectedMode;
    localStorage.setItem('networkingMode_' + (net && net.roomCode ? net.roomCode : sessionId), selectedMode);
    if (net && typeof net.setRoutingMode === 'function') {
      net.setRoutingMode(selectedMode);
    }
    const badgeText = selectedMode === 'p2p'
      ? 'Full P2P (mesh gossip)'
      : 'Admin-hosted (cloud relay)';
    $('#networkModeBadge').text(badgeText);

    console.log('[ClientNet] Broadcasting settings via admin relay:', newSettings);

    if (relayState && typeof relayState.updateSettings === 'function') {
      relayState.updateSettings(newSettings);
    }

    if (coordinator && typeof coordinator.broadcastSettings === 'function') {
      coordinator.broadcastSettings(newSettings);
    } else if (net) {
      net.send('admin-settings-updated', newSettings);
    }

    if (relayState && net && net.roomCode) {
      Persistence.saveAdminState(net.roomCode, relayState.getFullState());
    }

    applyParameterLockUI(wantLock);
    applyAutoDifficultyUI();
    refreshBlockPaceDisplay();
    showToastNotification(
      wantLock
        ? 'Settings updated and LOCKED — difficulty/reward/mode frozen'
        : (wasLocked ? 'Parameters unlocked and settings updated' : 'Settings broadcast to peers'),
      wantLock ? 'warning' : 'success'
    );
    updateSettingsDisplay(newSettings);

    if (typeof renderClientRelayChain === 'function') {
      renderClientRelayChain({ forceTopologyRelayout: true });
    }
    updateTopologyModeCaption(selectedMode);
  });
  
  // Network toggle — peers listen for 'network-toggled'; hub also rejects blocks/txs while paused.
  // Mobile MQTT is lossy (QoS 0) so we re-broadcast + embed pause in admin-presence ticks.
  $('#toggleNetworkBtn').click(function() {
    const isPaused = $(this).data('paused') || false;
    const willPause = !isPaused;
    $(this).text(willPause ? 'Resume Network' : 'Pause Network');
    $(this).data('paused', willPause);
    if (typeof relayState !== 'undefined' && relayState) {
      relayState.networkPaused = willPause;
    }
    broadcastNetworkPausedState(willPause, { burst: true });
    showToastNotification(
      willPause ? 'Network paused — mining and transactions halted' : 'Network resumed',
      willPause ? 'warning' : 'success'
    );
    if (relayState && net && net.roomCode && window.Persistence) {
      try { Persistence.saveAdminState(net.roomCode, relayState.getFullState()); } catch (e) {}
    }
  });

  // Copy address button
  $(document).on('click', '.copy-btn', function() {
    const text = $(this).data('clipboard-text');
    navigator.clipboard.writeText(text).then(() => {
      showToastNotification('Address copied to clipboard!', 'success');
    }).catch(err => {
      console.error('Could not copy text: ', err);
    });
  });

  $('#copyAdminAddressBtn').on('click', function () {
    const text = ($('#yourAddress').text() || '').trim();
    if (!text || text === 'Loading...') {
      showToastNotification('Address not ready yet', 'warning');
      return;
    }
    navigator.clipboard.writeText(text).then(() => {
      showToastNotification('Admin address copied', 'success');
    }).catch(() => {
      showToastNotification('Could not copy address', 'error');
    });
  });

  // Click a participant row / Use button to fill recipient
  $(document).on('click', '.use-recipient-btn', function () {
    const addr = $(this).data('address') || $(this).attr('data-address');
    if (!addr) return;
    $('#recipientAddress').val(addr);
    $('#transactionAmount').focus();
    showToastNotification('Recipient set — enter an amount and send', 'info');
  });

  // Admin wallet: submit a transfer into the hub mempool
  $('#transactionForm').on('submit', function (e) {
    e.preventDefault();
    submitAdminWalletTransaction();
  });
  
  // Clean up legacy 51% attack UI elements and inject Team Collusion Attack panel dynamically
  const $attackContainer = $('#startAttackBtn').parent();
  $('#attackerSelect').closest('.form-group').remove();
  $('#attackBlockIndex').closest('.form-group').remove();
  $('#startAttackBtn').siblings('p').remove(); // Remove legacy description
  $('#startAttackBtn').remove();
  
  $attackContainer.append(`
    <h4>Team 51% Collusion Attack</h4>
    <p class="small text-muted">Requires at least two miners. Assigns ~50% of miners to a collusion team that privately extends the chain from a parent block <em>blocks back</em> from the tip, producing a visible fork once they publish blocks.</p>
    <div class="form-group">
      <label>Blocks to fork back:</label>
      <input type="number" id="teamAttackBlocksBack" class="form-control" value="2" min="1" />
    </div>
    <button id="startTeamAttackBtn" class="btn btn-danger btn-block">Initiate Team Collusion</button>
    <div id="teamAttackStats" style="display:none; margin-top: 15px; padding: 10px; background: #fff3f3; border-radius: 4px;">
      <p class="text-success"><strong>Honest Hashrate:</strong> <span id="honestHashrate">0</span> H/s</p>
      <p class="text-danger"><strong>Collusion Hashrate:</strong> <span id="collusionHashrate">0</span> H/s</p>
    </div>
  `);
  
  $('#startTeamAttackBtn').click(function(e) {
    e.preventDefault();
    const blocksBack = Math.max(1, parseInt($('#teamAttackBlocksBack').val(), 10) || 2);
    if (!confirm('Initiate Team 51% attack simulation going back ' + blocksBack + ' blocks?')) return;
    startTeamCollusionAttack(blocksBack);
  });
  
  // Inject Hard Fork Simulation panel dynamically
  $('#teamAttackStats').after(`
    <hr>
    <h4>Hard Fork Simulation</h4>
    <p class="small text-muted">Propose a contentious hard fork at a specific block height. Miners choose which chain to follow, causing a permanent network split!</p>
    <div class="form-group">
      <label>Fork Name:</label>
      <input type="text" id="forkName" class="form-control" value="Big Block Fork" />
    </div>
    <div class="form-group">
      <label>Activation Block Height:</label>
      <input type="number" id="forkHeight" class="form-control" value="10" min="1" />
      <small class="form-text text-muted" id="forkHeightHint">Defaults to current height + 10 blocks.</small>
    </div>
    <button id="proposeForkBtn" class="btn btn-warning btn-block">Propose Hard Fork</button>
    <div id="adminForkStatus" style="display:none; margin-top:10px;" class="alert alert-warning"></div>
  `);

  // Keep default activation = tip + 10 until the instructor edits the field
  $('#forkHeight').data('userEdited', false);
  $('#forkHeight').on('input change', function () {
    $(this).data('userEdited', true);
  });
  refreshForkHeightDefault(true);
  
  $('#proposeForkBtn').click(function(e) {
    e.preventDefault();
    // On initiate: if they left the default alone, snap to current tip + 10
    if (!$('#forkHeight').data('userEdited')) {
      refreshForkHeightDefault(true);
    }
    const height = parseInt($('#forkHeight').val(), 10) || defaultForkActivationHeight();
    const name = ($('#forkName').val() || 'Hard Fork').trim() || 'Hard Fork';
    if (!Number.isFinite(height) || height < 1) {
      showToastNotification('Enter a valid activation block height', 'error');
      return;
    }
    if (!confirm('Propose “' + name + '” at block ' + height + ' (current tip is ' + getHubBlockHeight() + ')?')) return;
    proposeHardFork(name, height);
  });

  // === Client-relay testing helper button ===
  const $netPanel = $('#updateSettingsBtn').closest('.panel-body');
  if ($netPanel.length) {
      $netPanel.append(`
        <div style="margin-top:14px; padding-top:10px; border-top:1px solid #eee;">
          <button id="openTestPeerBtn" class="btn btn-info btn-sm btn-block">Open Test Miner Tab</button>
          <small class="text-muted">Opens a <strong>new</strong> miner identity in a new tab each click. Use a second browser or phone for a true classroom test.</small>
        </div>
      `);

      $('#openTestPeerBtn').on('click', function() {
        const rc = (window.LabPaths && LabPaths.getSessionIdFromLocation()) || (window.location.pathname.split('/').pop() || '');
        const code = String(rc).toUpperCase();
        // Always mint a brand-new miner identity. Do NOT write userId into the
        // shared localStorage key — that would steal identity from other open tabs.
        const freshId = 'test-miner-' + Date.now().toString(36) + '-' +
          Math.random().toString(36).substr(2, 6);
        localStorage.setItem('joinCode_' + code, code);
        localStorage.setItem('networkingMode_' + code, networkMode || 'admin-relay');
        let url = (window.LabPaths && LabPaths.labUrl)
          ? LabPaths.labUrl('participate', code)
          : ('/lab/participate/' + code);
        url += (url.indexOf('?') >= 0 ? '&' : '?') + 'uid=' + encodeURIComponent(freshId);
        // Unique window name so the browser doesn't reuse an existing miner tab
        window.open(url, 'lab-test-miner-' + freshId);
      });
    }
}

function updateDifficultyDisplay() {
  const leading = parseInt($('#difficultyLeading').val());
  const secondary = parseInt($('#difficultySecondary').val());
  
  $('#difficultyLeadingValue').text(leading);
  $('#difficultySecondaryValue').text(secondary.toString(16).toUpperCase());
}

/** Freeze difficulty/reward/mode controls when parameters are locked. */
function applyParameterLockUI(locked) {
  const on = !!locked;
  $('#miningReward, #networkModeSelect, #targetBlockTimeSec, #autoDifficulty')
    .prop('disabled', on);
  // Difficulty sliders: locked OR auto-managed
  applyAutoDifficultyUI();
  if (on) {
    $('#difficultyLeading, #difficultySecondary').prop('disabled', true);
    $('#lockParameters').closest('.checkbox').addClass('text-danger');
  } else {
    $('#lockParameters').closest('.checkbox').removeClass('text-danger');
  }
}

/** When auto-difficulty is on, sliders are driven by the hub (read-only). */
function applyAutoDifficultyUI() {
  const locked = $('#lockParameters').is(':checked') ||
    !!(relayState && relayState.settings && relayState.settings.parametersLocked);
  const auto = $('#autoDifficulty').is(':checked');
  const freezeDiff = locked || auto;
  $('#difficultyLeading, #difficultySecondary').prop('disabled', freezeDiff);
  const $badge = $('#autoDifficultyBadge');
  if ($badge.length) {
    if (auto) {
      $badge.text('Auto difficulty ON').removeClass('label-default label-warning').addClass('label-success');
    } else {
      $badge.text('Manual difficulty').removeClass('label-success label-default').addClass('label-warning');
    }
  }
}

function refreshBlockPaceDisplay() {
  const target = (relayState && relayState.settings && relayState.settings.targetBlockTimeSec) ||
    parseInt($('#targetBlockTimeSec').val(), 10) || 10;
  const avgMs = relayState && relayState.networkStats && relayState.networkStats.averageBlockTimeMs;
  let text = '—';
  if (avgMs != null && !isNaN(avgMs) && avgMs > 0) {
    const sec = avgMs / 1000;
    text = (sec >= 10 ? sec.toFixed(0) : sec.toFixed(1)) + 's (target ' + target + 's)';
  } else {
    text = 'warming up… (target ' + target + 's)';
  }
  $('#observedBlockTimeAvg').text(text);
}

/**
 * Broadcast pause/resume to all peers.
 * Mobile MQTT (QoS 0) drops packets — send a short burst + stamp transport presence.
 */
function broadcastNetworkPausedState(paused, opts) {
  opts = opts || {};
  const willPause = !!paused;
  if (typeof relayState !== 'undefined' && relayState) {
    relayState.networkPaused = willPause;
  }
  // So periodic admin-presence ticks carry the flag
  if (net && net.transport) {
    net.transport.networkPaused = willPause;
  }
  if (!net) return;

  const sendOnce = function (seq) {
    const payload = {
      paused: willPause,
      networkPaused: willPause,
      seq: seq || Date.now(),
      reason: opts.reason || 'admin-toggle'
    };
    // Primary event miners listen for
    net.send('network-toggled', payload);
    // Legacy alias
    net.send('toggle-network', payload);
  };

  sendOnce(Date.now());
  if (opts.burst) {
    // Extra deliveries for phones that reconnect / miss the first publish
    setTimeout(function () { sendOnce(Date.now()); }, 350);
    setTimeout(function () { sendOnce(Date.now()); }, 1200);
    setTimeout(function () { sendOnce(Date.now()); }, 2800);
  }
}

// Legacy loadBlockchainState removed (client-relay only now uses renderClientRelayChain)

function updateBlockchainView(mainChain, orphans, participants) {
  if (window.ChainDisplay && typeof ChainDisplay.renderChainHtml === 'function') {
    $('#blockchainView').html(
      ChainDisplay.renderChainHtml({
        mainChain: mainChain || [],
        orphans: orphans || [],
        participants: participants || [],
        openTxPanels: openTxPanels
      })
    );
    return;
  }
  $('#blockchainView').html('<p class="text-muted">Chain display unavailable</p>');
}

function toggleTransactions(blockIndex) {
  const $el = $('#txDetails_' + blockIndex);
  $el.toggle();
  if ($el.is(':visible')) {
    openTxPanels.add(blockIndex.toString());
  } else {
    openTxPanels.delete(blockIndex.toString());
  }
}

function updateNetworkStats(blockchain) {
  const stats = blockchain.networkStats || {};
  $('#blockHeight').text(stats.blockHeight || 0);
  $('#participantCount').text(blockchain.participants ? blockchain.participants.length : 0);
  $('#totalHashrate').text((stats.totalHashrate || 0).toFixed(0) + ' H/s');
  
  if (stats.lastBlockTime) {
    const secondsAgo = Math.floor((Date.now() - stats.lastBlockTime) / 1000);
    $('#lastBlockTime').text(secondsAgo + 's');
  }
}

function updateParticipantsList(blockchain) {
  const participants = blockchain.participants || [];
  let html = '';
  
  participants.forEach(p => {
    const roleClass = p.role === 'wallet' ? 'label-info' : 'label-success';
    const roleText = p.role === 'wallet' ? 'Wallet' : 'Miner';
    const attackerLabel = p.isAttacker ? ' <span class="label label-danger" style="margin-left: 4px;">Attacker</span>' : '';
    const nameHtml = p.name ? `<strong style="display:block; margin-bottom:2px;">${p.name}</strong>` : '';
    html += `
      <tr>
        <td>
          ${nameHtml}
          <code style="font-size: 11px; word-break: break-all;">${p.address}</code>
          <button class="btn btn-xs btn-default pull-right copy-btn" data-clipboard-text="${p.address}" title="Copy Address"><i class="glyphicon glyphicon-copy"></i></button>
        </td>
        <td><span class="label ${roleClass}">${roleText}</span></td>
        <td><span class="label ${roleClass}">${roleText}</span>${attackerLabel}</td>
        <td><strong>${p.minedBlocks}</strong></td>
        <td>${p.balance} coins</td>
        <td><span class="text-success">Live</span></td>
      </tr>
    `;
  });
  
  if (participants.length === 0) {
    html = '<tr><td colspan="5" class="text-center text-muted">No miners or wallets yet</td></tr>';
  }
  
  $('#participantsList').html(html);
}

// Store node info for display
let nodeInfo = new Map(); // Maps userId to {name, status}

function updateNodeNamesList() {
  let html = '';
  
  if (nodeInfo.size === 0) {
    html = '<tr><td colspan="3" class="text-center text-muted">No miners have joined yet</td></tr>';
  } else {
    nodeInfo.forEach((info, userId) => {
      html += `
        <tr>
          <td><code style="font-size: 11px;">${userId.substring(0, 12)}...</code></td>
          <td>${info.name || '<span style="color: #999;">Unnamed</span>'}</td>
          <td><span class="label ${info.status === 'mining' ? 'label-success' : 'label-default'}">${info.status || 'idle'}</span></td>
        </tr>
      `;
    });
  }
  
  $('#nodeNamesList').html(html);
}

function updateSettingsDisplay(settings) {
  if (!settings) return;
  $('#adminDifficultyLeading').text(settings.difficultyLeading);
  $('#adminDifficultySecondary').text('0x' + Number(settings.difficultySecondary != null ? settings.difficultySecondary : 8).toString(16).toUpperCase());
  $('#adminMiningReward').text((settings.miningRewardCoins || 0) + ' coins');
  $('#adminParams').html(settings.parametersLocked ?
    '<span class="label label-danger">Locked</span>' :
    '<span class="label label-success">Unlocked</span>'
  );

  // Auto-sync the sliders to match the server defaults on first load
  if (!initialSettingsLoaded) {
    $('#difficultyLeading').val(settings.difficultyLeading != null ? settings.difficultyLeading : 1);
    $('#difficultySecondary').val(settings.difficultySecondary != null ? settings.difficultySecondary : 8);
    $('#miningReward').val(settings.miningRewardCoins);
    if (settings.targetBlockTimeSec != null) $('#targetBlockTimeSec').val(settings.targetBlockTimeSec);
    if (typeof settings.autoDifficulty === 'boolean') $('#autoDifficulty').prop('checked', settings.autoDifficulty);
    $('#networkModeSelect').val(settings.networkMode === 'p2p' ? 'p2p' : 'admin-relay');
    $('#lockParameters').prop('checked', settings.parametersLocked);
    updateDifficultyDisplay();
    applyParameterLockUI(!!settings.parametersLocked);
    applyAutoDifficultyUI();
    refreshBlockPaceDisplay();
    initialSettingsLoaded = true;
  }
}

/**
 * Team 51% collusion: split miners into colluders vs honest, fork from tip-N.
 * Broadcasts team-attack-started so miner tabs actually enter collusion mode.
 */
function startTeamCollusionAttack(blocksBack) {
  blocksBack = Math.max(1, parseInt(blocksBack, 10) || 2);
  if (!net) {
    showToastNotification('Network hub not ready', 'error');
    return;
  }
  if (!relayState || !Array.isArray(relayState.chain) || relayState.chain.length === 0) {
    showToastNotification('No chain yet — wait for genesis / first blocks', 'error');
    return;
  }

  const minerIds = Array.from(relayState.participants.values())
    .filter(function (p) {
      const id = p.userId || p.id || '';
      if (!id || String(id).indexOf('probe-') === 0) return false;
      const role = String(p.role || 'miner').toLowerCase();
      if (role === 'admin' || role === 'wallet' || role === 'observer' || role === 'hub') return false;
      return true;
    })
    .map(function (p) { return p.userId || p.id; });

  if (minerIds.length < 2) {
    showToastNotification('Need at least 2 miners (wallets/admin do not count)', 'error');
    return;
  }

  // Fisher–Yates shuffle
  for (let i = minerIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = minerIds[i];
    minerIds[i] = minerIds[j];
    minerIds[j] = tmp;
  }

  const half = Math.ceil(minerIds.length / 2);
  const colluders = minerIds.slice(0, half);
  const honest = minerIds.slice(half);

  const chain = relayState.chain;
  const tipIndex = Math.max(0, chain.length - 1);
  const forkParentIndex = Math.max(0, tipIndex - blocksBack);
  const forkBlock = chain[forkParentIndex] || chain[0];
  const forkIndex = forkBlock.index != null ? forkBlock.index : forkParentIndex;

  colluders.forEach(function (id) {
    relayState.addOrUpdateParticipant(id, 'miner', { isAttacker: true, isColluding: true, status: 'attacking' });
  });
  honest.forEach(function (id) {
    relayState.addOrUpdateParticipant(id, 'miner', { isAttacker: false, isColluding: false });
  });

  const payload = {
    colluders: colluders,
    honest: honest,
    forkBlock: { hash: forkBlock.hash, index: forkIndex },
    blocksBack: blocksBack,
    appliesAtBlock: tipIndex + blocksBack
  };

  // Event name miners actually listen for
  net.send('team-attack-started', payload);

  // Hashrate stats for projector
  let honestHr = 0;
  let collusionHr = 0;
  colluders.forEach(function (id) {
    const p = relayState.participants.get(id);
    collusionHr += (p && p.hashrate) ? Number(p.hashrate) : 0;
  });
  honest.forEach(function (id) {
    const p = relayState.participants.get(id);
    honestHr += (p && p.hashrate) ? Number(p.hashrate) : 0;
  });
  $('#honestHashrate').text(honestHr.toFixed(0));
  $('#collusionHashrate').text(collusionHr.toFixed(0));
  $('#teamAttackStats').show();

  if (typeof renderClientParticipants === 'function') renderClientParticipants();
  if (typeof renderClientRelayChain === 'function') renderClientRelayChain();

  showToastNotification(
    'Team collusion started: ' + colluders.length + ' colluder(s), ' + honest.length + ' honest — forking from block #' + forkIndex,
    'warning'
  );
}

/** Current canonical tip height (0 = genesis). */
function getHubBlockHeight() {
  if (relayState && Array.isArray(relayState.chain) && relayState.chain.length > 0) {
    const tip = relayState.chain[relayState.chain.length - 1];
    if (tip && tip.index != null && !isNaN(tip.index)) return Math.max(0, Number(tip.index));
    return Math.max(0, relayState.chain.length - 1);
  }
  return 0;
}

/** Default hard-fork activation: 10 blocks after the current tip. */
function defaultForkActivationHeight() {
  return getHubBlockHeight() + 10;
}

/**
 * Keep the activation height field on tip+10 unless the instructor edited it
 * or is currently typing in the field.
 */
function refreshForkHeightDefault(force) {
  const $el = $('#forkHeight');
  if (!$el.length) return;
  if (!force && $el.is(':focus')) return;
  if (!force && $el.data('userEdited')) return;
  const suggested = defaultForkActivationHeight();
  $el.val(suggested);
  const tip = getHubBlockHeight();
  $('#forkHeightHint').text(
    'Default: current height (' + tip + ') + 10 → activates at block ' + suggested + '.'
  );
}

/** Broadcast hard-fork proposal (event name miners listen for). */
function proposeHardFork(name, height) {
  if (!net) {
    showToastNotification('Network hub not ready', 'error');
    return;
  }
  let h = parseInt(height, 10);
  if (!Number.isFinite(h) || h < 1) {
    h = defaultForkActivationHeight();
  }
  const n = (name || 'Hard Fork').trim() || 'Hard Fork';

  if (relayState) {
    relayState.pendingFork = { height: h, name: n };
  }

  net.send('hard-fork-proposed', { height: h, name: n });

  const $st = $('#adminForkStatus');
  if ($st.length) {
    $st.show().html(
      '<strong>Hard fork proposed:</strong> ' + n +
      ' at height <strong>' + h + '</strong> (tip was ' + getHubBlockHeight() +
      '). Miners should see a choice modal.'
    );
  }
  showToastNotification('Hard fork proposed: ' + n + ' @ block ' + h, 'warning');
}

function playBlockMinedAnimation() {
  // Play a subtle animation
  const $view = $('#blockchainView');
  $view.fadeOut(100).fadeIn(100);
}

// === Render the blockchain from relayState (canonical + competing miner forks) ===
// Debounce full DOM rebuilds — fast mining otherwise makes admin controls unclickable.
var _relayRenderTimer = null;
var _persistAdminTimer = null;

function schedulePersistAdminState() {
  if (_persistAdminTimer) return;
  _persistAdminTimer = setTimeout(function () {
    _persistAdminTimer = null;
    if (relayState && net && net.roomCode && typeof Persistence !== 'undefined') {
      try { Persistence.saveAdminState(net.roomCode, relayState.getFullState()); } catch (e) {}
    }
  }, 2000);
}

function scheduleRenderClientRelayChain() {
  // Keep height/stats snappy even while the heavy chain HTML is throttled
  if (relayState) {
    try {
      const chainLen = (relayState.chain && relayState.chain.length) ? relayState.chain.length : 0;
      $('#blockHeight').text(relayState.networkStats.blockHeight || Math.max(0, chainLen - 1));
      $('#participantCount').text(relayState.participants ? relayState.participants.size : 0);
      if (relayState.networkStats && relayState.networkStats.totalHashrate != null) {
        $('#totalHashrate').text((relayState.networkStats.totalHashrate || 0).toFixed(0) + ' H/s');
      }
      if (relayState.networkStats && relayState.networkStats.lastBlockTime) {
        const secondsAgo = Math.floor((Date.now() - relayState.networkStats.lastBlockTime) / 1000);
        $('#lastBlockTime').text(secondsAgo + 's');
      }
    } catch (e) {}
  }
  if (_relayRenderTimer) return;
  _relayRenderTimer = setTimeout(function () {
    _relayRenderTimer = null;
    renderClientRelayChain();
  }, 400);
}

/**
 * Bitcoin-style sparse gossip topology for the projector (and packet paths).
 * Each node keeps ~3–4 peers; the graph rewires every ~15–20s.
 */
var _gossipTopo = {
  adj: new Map(), // userId -> Set(peerIds)
  idKey: '',
  lastRewire: 0,
  rewireIntervalMs: 17000,
  minDegree: 3,
  maxDegree: 4
};

function _shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/** Build an undirected sparse graph: degree roughly 3–4 (Bitcoin-ish). */
function buildSparseGossipAdjacency(nodeIds) {
  const adj = new Map();
  const n = nodeIds.length;
  if (n < 2) return adj;

  nodeIds.forEach(function (id) { adj.set(id, new Set()); });

  const maxDeg = Math.min(_gossipTopo.maxDegree, n - 1);
  const minDeg = Math.min(_gossipTopo.minDegree, maxDeg);

  // Each node tries to form minDeg..maxDeg random undirected links
  nodeIds.forEach(function (id) {
    const want = minDeg + Math.floor(Math.random() * (maxDeg - minDeg + 1));
    const others = nodeIds.filter(function (x) { return x !== id; });
    _shuffleInPlace(others);
    let added = 0;
    for (let i = 0; i < others.length && added < want; i++) {
      const peer = others[i];
      if (adj.get(id).has(peer)) {
        added += 1;
        continue;
      }
      // Soft cap: avoid hubs ballooning past maxDeg+1
      if (adj.get(peer).size >= maxDeg + 1) continue;
      adj.get(id).add(peer);
      adj.get(peer).add(id);
      added += 1;
    }
  });

  // Guarantee minimum degree where possible
  nodeIds.forEach(function (id) {
    const neighbors = adj.get(id);
    while (neighbors.size < minDeg) {
      const candidates = nodeIds.filter(function (x) {
        return x !== id && !neighbors.has(x);
      });
      if (!candidates.length) break;
      const peer = candidates[Math.floor(Math.random() * candidates.length)];
      neighbors.add(peer);
      adj.get(peer).add(id);
    }
  });

  // Ensure the graph is connected (single component) so gossip can reach everyone
  const components = [];
  const seen = new Set();
  nodeIds.forEach(function (start) {
    if (seen.has(start)) return;
    const comp = [];
    const q = [start];
    seen.add(start);
    while (q.length) {
      const cur = q.shift();
      comp.push(cur);
      adj.get(cur).forEach(function (nb) {
        if (!seen.has(nb)) {
          seen.add(nb);
          q.push(nb);
        }
      });
    }
    components.push(comp);
  });
  for (let c = 1; c < components.length; c++) {
    const a = components[c - 1][0];
    const b = components[c][0];
    adj.get(a).add(b);
    adj.get(b).add(a);
  }

  return adj;
}

/**
 * Soft rewire: randomly replace ~25% of edges so the classroom sees churn
 * without a full topology explosion.
 */
function rewireSparseGossipAdjacency(nodeIds, adj) {
  if (!adj || nodeIds.length < 3) return adj;
  const maxDeg = Math.min(_gossipTopo.maxDegree, nodeIds.length - 1);
  const minDeg = Math.min(_gossipTopo.minDegree, maxDeg);

  nodeIds.forEach(function (id) {
    if (Math.random() > 0.35) return; // only some nodes churn each rewire
    const neighbors = adj.get(id);
    if (!neighbors || neighbors.size === 0) return;

    // Drop one random peer
    const list = Array.from(neighbors);
    const drop = list[Math.floor(Math.random() * list.length)];
    neighbors.delete(drop);
    if (adj.get(drop)) adj.get(drop).delete(id);

    // Add a new random peer (not self, not already linked)
    const candidates = nodeIds.filter(function (x) {
      return x !== id && !neighbors.has(x) && (adj.get(x) || new Set()).size < maxDeg + 1;
    });
    if (candidates.length) {
      const peer = candidates[Math.floor(Math.random() * candidates.length)];
      neighbors.add(peer);
      adj.get(peer).add(id);
    }

    // Repair min degree if we dropped without a replacement
    while (neighbors.size < minDeg) {
      const fix = nodeIds.filter(function (x) {
        return x !== id && !neighbors.has(x);
      });
      if (!fix.length) break;
      const peer = fix[Math.floor(Math.random() * fix.length)];
      neighbors.add(peer);
      adj.get(peer).add(id);
    }
  });

  return adj;
}

/**
 * Maintain gossip adjacency across renders. Rebuilds when membership changes;
 * soft-rewires on a timer (or when __forceGossipRewire is set).
 */
function ensureGossipTopology(nodeIds, opts) {
  opts = opts || {};
  const ids = (nodeIds || []).slice().filter(Boolean).sort();
  const idKey = ids.join('\0');
  const now = Date.now();
  const membershipChanged = idKey !== _gossipTopo.idKey;
  const forceRewire = !!(opts.forceRewire || window.__forceGossipRewire);
  window.__forceGossipRewire = false;

  if (ids.length < 2) {
    _gossipTopo.adj = new Map();
    _gossipTopo.idKey = idKey;
    _gossipTopo.lastRewire = now;
    return _gossipTopo.adj;
  }

  if (membershipChanged || !_gossipTopo.adj || _gossipTopo.adj.size === 0) {
    _gossipTopo.adj = buildSparseGossipAdjacency(ids);
    _gossipTopo.idKey = idKey;
    _gossipTopo.lastRewire = now;
    _gossipTopo.rewired = true;
    return _gossipTopo.adj;
  }

  // Membership stable but IDs may have been reordered — keep graph, prune ghosts
  const idSet = new Set(ids);
  _gossipTopo.adj.forEach(function (peers, id) {
    if (!idSet.has(id)) {
      _gossipTopo.adj.delete(id);
      return;
    }
    peers.forEach(function (p) {
      if (!idSet.has(p)) peers.delete(p);
    });
  });
  ids.forEach(function (id) {
    if (!_gossipTopo.adj.has(id)) _gossipTopo.adj.set(id, new Set());
  });

  const due = (now - _gossipTopo.lastRewire) >= _gossipTopo.rewireIntervalMs;
  if (forceRewire || due) {
    rewireSparseGossipAdjacency(ids, _gossipTopo.adj);
    _gossipTopo.lastRewire = now;
    _gossipTopo.rewired = true;
  } else {
    _gossipTopo.rewired = false;
  }
  _gossipTopo.idKey = idKey;
  return _gossipTopo.adj;
}

function gossipAdjToPeerAssignments(adj) {
  const peerAssignments = new Map();
  if (!adj) return peerAssignments;
  adj.forEach(function (peers, id) {
    peerAssignments.set(id, Array.from(peers));
  });
  return peerAssignments;
}

/**
 * Build projector link map from the current networking mode.
 * Admin-hosted → star around the hub;
 * Full P2P → sparse gossip (~3–4 peers each, periodic rewiring).
 */
function buildVizPeerAssignments(vizMiners, mode, opts) {
  opts = opts || {};
  const peerAssignments = new Map();
  if (!vizMiners || vizMiners.length < 2) return peerAssignments;

  const isP2p = mode === 'p2p' || mode === 'mesh';
  if (isP2p) {
    const ids = vizMiners.map(function (m) { return m.userId; }).filter(Boolean);
    const adj = ensureGossipTopology(ids, opts);
    return gossipAdjToPeerAssignments(adj);
  }

  // Star around the instructor hub
  const center = vizMiners.find(function (m) {
    return m.role === 'admin' || /admin/i.test(m.userId || '') || /admin/i.test(m.name || '');
  }) || vizMiners[0];
  if (center) {
    vizMiners.forEach(function (m) {
      if (m.userId !== center.userId) {
        peerAssignments.set(m.userId, [center.userId]);
      }
    });
  }
  return peerAssignments;
}

function resolveVizNetworkMode() {
  if (networkMode) return networkMode;
  if (relayState && relayState.settings && relayState.settings.networkMode) {
    return relayState.settings.networkMode;
  }
  return 'admin-relay';
}

function updateTopologyModeCaption(mode) {
  const isP2p = mode === 'p2p' || mode === 'mesh';
  let text = 'Layout: Admin-hosted star (hub in the center)';
  if (isP2p) {
    const n = _gossipTopo.adj ? _gossipTopo.adj.size : 0;
    let avgDeg = 0;
    if (n > 0) {
      let edges = 0;
      _gossipTopo.adj.forEach(function (peers) { edges += peers.size; });
      avgDeg = edges / n;
    }
    text = 'Layout: P2P gossip (~3–4 peers each' +
      (avgDeg ? ', avg ' + avgDeg.toFixed(1) : '') +
      ') — rewires every ~15–20s';
  }
  let $el = $('#topologyModeCaption');
  if (!$el.length) {
    $('#networkTopologyLegend').prepend(
      '<div id="topologyModeCaption" style="margin-bottom:8px;font-size:12px;font-weight:600;color:#37474f;"></div>'
    );
    $el = $('#topologyModeCaption');
  }
  $el.text(text);
}

function renderClientRelayChain(opts) {
  opts = opts || {};
  if (!relayState || !relayState.chain || relayState.chain.length === 0) {
    $('#blockchainView').html('<p class="text-muted">Waiting for first blocks...</p>');
    return;
  }

  const chain = relayState.chain;
  const participants = Array.from(relayState.participants.values());
  const mainHashes = new Set(chain.map(function (b) { return b.hash; }));
  const orphans = [];
  if (relayState.allBlocks && typeof relayState.allBlocks.forEach === 'function') {
    relayState.allBlocks.forEach(function (block, hash) {
      if (hash && !mainHashes.has(hash) && block && block.miner !== 'genesis') {
        orphans.push(block);
      }
    });
  }

  // Side-by-side main chain + each miner's competing / orphaned blocks
  if (typeof updateBlockchainView === 'function') {
    updateBlockchainView(chain, orphans, participants);
  }

  // Also update stats
  $('#blockHeight').text(relayState.networkStats.blockHeight || chain.length - 1);
  $('#participantCount').text(relayState.participants.size);
  $('#totalHashrate').text((relayState.networkStats.totalHashrate || 0).toFixed(0) + ' H/s');
  if (relayState.networkStats.lastBlockTime) {
    const secondsAgo = Math.floor((Date.now() - relayState.networkStats.lastBlockTime) / 1000);
    $('#lastBlockTime').text(secondsAgo + 's');
  }
  const avgMs = relayState.networkStats.averageBlockTimeMs;
  if (avgMs != null && !isNaN(avgMs) && chain.length > 1) {
    const avgSec = avgMs / 1000;
    $('#avgBlockTime').text(avgSec >= 10 ? avgSec.toFixed(0) + 's' : avgSec.toFixed(1) + 's');
  } else {
    $('#avgBlockTime').text('—');
  }
  if (typeof refreshBlockPaceDisplay === 'function') refreshBlockPaceDisplay();
  if (typeof refreshForkHeightDefault === 'function') refreshForkHeightDefault(false);

  // Update participants table from relay state
  renderClientParticipants();

  // Shared mempool (pending txs) — visible on admin projector
  if (typeof updatePendingTransactions === 'function') {
    updatePendingTransactions({
      pendingTransactions: Array.isArray(relayState.pendingTransactions)
        ? relayState.pendingTransactions
        : [],
      participants: participants
    });
  }

  // Feed live data to network visualization
  const viz = window.networkViz || networkViz;
  if (viz && typeof viz.updateTopology === 'function') {
    try {
      const participantsArr = Array.from(relayState.participants.values())
        .filter(function (p) {
          const id = p.userId || p.id || '';
          return id && String(id).indexOf('probe-') !== 0;
        });
      const vizMiners = participantsArr.map(function (p) {
        var st = p.status;
        if (!st) {
          if (p.role === 'admin') st = 'idle';
          else if ((p.hashrate || 0) > 0) st = 'mining';
          else st = 'idle';
        }
        return {
          userId: p.userId || p.id,
          name: p.displayName || p.name || String(p.userId || '').substring(0, 8),
          status: st,
          chainHeight: p.blocksMined || 0,
          hashrate: p.hashrate || 0,
          address: p.userId,
          role: p.role || 'miner'
        };
      });
      const mode = resolveVizNetworkMode();
      const peerAssignments = buildVizPeerAssignments(vizMiners, mode, {
        forceRewire: !!opts.forceGossipRewire
      });
      const isP2p = mode === 'p2p' || mode === 'mesh';
      const topoMode = isP2p ? 'gossip' : 'star';
      const rewired = !!_gossipTopo.rewired;
      viz.updateTopology(vizMiners, peerAssignments, {
        topologyMode: topoMode,
        forceRelayout: !!opts.forceTopologyRelayout || rewired
      });
      updateTopologyModeCaption(mode);

      const tip = chain[chain.length - 1];
      if (tip && tip.miner && tip.miner !== 'genesis' && tip.hash) {
        // Pulse when tip changes (avoid constant yellow flash)
        if (viz._lastTipHash !== tip.hash) {
          viz._lastTipHash = tip.hash;
          if (typeof viz.blockFound === 'function') viz.blockFound(tip.miner);
        }
      }
    } catch (e) {
      console.warn('[Viz] updateTopology non-fatal:', e && e.message);
    }
  }
}

/** Render the shared mempool table (pending transactions). */
function updatePendingTransactions(blockchain) {
  const transactions = (blockchain && blockchain.pendingTransactions) || [];
  const participants = (blockchain && blockchain.participants) ||
    (relayState ? Array.from(relayState.participants.values()) : []);
  const CD = window.ChainDisplay;
  const nameLookup = CD ? CD.buildParticipantNameLookup(participants) : {};
  const fmtAddr = (addr) => (CD
    ? CD.formatChainParticipantHtml(addr, nameLookup)
    : `<code style="font-size:11px;word-break:break-all;">${addr || ''}</code>`);

  let html = '';
  transactions.forEach((tx) => {
    html += `
      <tr>
        <td>${fmtAddr(tx.from)}</td>
        <td>${fmtAddr(tx.to)}</td>
        <td><strong>${tx.amount}</strong></td>
        <td>${tx.timestamp ? new Date(tx.timestamp).toLocaleTimeString() : '—'}</td>
      </tr>
    `;
  });
  if (transactions.length === 0) {
    html = '<tr><td colspan="4" class="text-center text-muted">No pending transactions</td></tr>';
  }
  $('#pendingTransactions').html(html);
  const $badge = $('#mempoolCountBadge');
  if ($badge.length) {
    $badge.text(String(transactions.length));
    $badge
      .toggleClass('label-default', transactions.length === 0)
      .toggleClass('label-warning', transactions.length > 0);
  }
}

/** Refresh admin wallet address + confirmed balance from hub state */
function updateAdminWalletUI() {
  if (!net || !net.userId) return;
  $('#yourAddress').text(net.userId);
  if (!relayState || !relayState.participants) {
    $('#yourBalance').text('0');
    return;
  }
  const me = relayState.participants.get(net.userId);
  const bal = me && me.balance != null ? me.balance : 0;
  $('#yourBalance').text(bal);
}

/**
 * Instructor sends coins from the admin hub wallet into the mempool.
 * Same path as student wallets, but local (no MQTT round-trip to self).
 */
function submitAdminWalletTransaction() {
  if (!net || !net.userId) {
    showToastNotification('Hub not ready yet', 'error');
    return;
  }
  if (relayState && relayState.networkPaused) {
    showToastNotification('Network is paused — transactions blocked', 'warning');
    return;
  }

  const toUserId = ($('#recipientAddress').val() || '').trim();
  const amount = parseFloat($('#transactionAmount').val());
  if (!toUserId || !amount || amount <= 0) {
    showToastNotification('Enter a valid recipient address and amount', 'error');
    return;
  }
  if (toUserId === net.userId) {
    showToastNotification('Cannot send to yourself', 'error');
    return;
  }

  const me = relayState && relayState.participants
    ? relayState.participants.get(net.userId)
    : null;
  const bal = me && me.balance != null ? Number(me.balance) : 0;
  if (bal < amount) {
    showToastNotification('Insufficient balance (' + bal + ' coins available)', 'error');
    return;
  }

  const tx = {
    from: net.userId,
    to: toUserId,
    amount: amount,
    timestamp: Date.now()
  };

  let result = { accepted: false };
  if (relayState && typeof relayState.tryAddTransaction === 'function') {
    result = relayState.tryAddTransaction(tx) || result;
  }
  if (!result.accepted) {
    showToastNotification((result && result.reason) || 'Transaction rejected', 'error');
    return;
  }
  if (result.duplicate) {
    showToastNotification('Transaction already in mempool', 'info');
    return;
  }

  const pending = relayState.pendingTransactions
    ? relayState.pendingTransactions.slice()
    : [];
  const participants = relayState.participants
    ? Array.from(relayState.participants.values())
    : [];

  net.send('transaction-accepted', {
    transaction: result.transaction || tx,
    pendingTransactions: pending,
    participants: participants
  });

  // Local projector refresh
  if (typeof renderClientParticipants === 'function') renderClientParticipants();
  if (typeof updatePendingTransactions === 'function') {
    updatePendingTransactions({
      pendingTransactions: pending,
      participants: participants
    });
  }
  if (typeof scheduleRenderClientRelayChain === 'function') scheduleRenderClientRelayChain();
  else if (typeof renderClientRelayChain === 'function') renderClientRelayChain();
  updateAdminWalletUI();

  $('#recipientAddress').val('');
  $('#transactionAmount').val('');
  showToastNotification('Transaction added to mempool — miners will include it', 'success');

  // Topology animation
  try {
    const viz = window.networkViz || networkViz;
    if (viz && typeof viz.animateTransactionPropagation === 'function') {
      viz.animateTransactionPropagation(net.userId, result.transaction || tx);
    }
  } catch (e) {}
}

// Render participants list from relayState (client-relay mode)
function renderClientParticipants() {
  if (!relayState) return;

  const participants = Array.from(relayState.participants.values())
    .filter(function (p) {
      const id = p.userId || '';
      return id && String(id).indexOf('probe-') !== 0;
    });
  let html = '';

  if (participants.length === 0) {
    html = '<tr><td colspan="5" class="text-center text-muted">No miners or wallets yet</td></tr>';
  } else {
    const adminId = net && net.userId ? net.userId : '';
    participants.forEach(p => {
      const roleClass = p.role === 'wallet' ? 'label-info' : (p.role === 'admin' ? 'label-warning' : 'label-success');
      const roleText = p.role === 'wallet' ? 'Wallet' : (p.role === 'admin' ? 'Admin' : 'Miner');
      const mined = p.blocksMined != null ? p.blocksMined : (p.minedBlocks || 0);
      const name = p.displayName || p.name || '';
      const nameHtml = name ? `<strong style="display:block;margin-bottom:2px;">${name}</strong>` : '';
      const attackerLabel = (p.isAttacker || p.isColluding)
        ? ' <span class="label label-danger">Attacker</span>'
        : '';
      const forkLabel = (p.forkChoice && p.forkChoice !== 'classic')
        ? ' <span class="label label-info">' + String(p.forkChoice).toUpperCase() + '</span>'
        : '';
      const isSelf = adminId && p.userId === adminId;
      const useBtn = isSelf
        ? ''
        : `<button type="button" class="btn btn-xs btn-default use-recipient-btn" data-address="${p.userId}" title="Send coins to this address" style="margin-top:4px;">Send to…</button>`;
      html += `
        <tr>
          <td>
            ${nameHtml}
            <code style="font-size: 11px; word-break: break-all;">${p.userId}</code>
            ${useBtn}
          </td>
          <td><span class="label ${roleClass}">${roleText}</span>${attackerLabel}${forkLabel}</td>
          <td><strong>${mined}</strong></td>
          <td>${p.balance || 0} coins</td>
          <td><span class="text-success">${p.status || 'idle'}</span> <small>(${(p.hashrate || 0).toFixed(0)} H/s)</small></td>
        </tr>
      `;
    });
  }

  $('#participantsList').html(html);
  updateAdminWalletUI();

  // Keep Node Names table in sync too
  let namesHtml = '';
  if (participants.length === 0) {
    namesHtml = '<tr><td colspan="3" class="text-center text-muted">Waiting for miners to join...</td></tr>';
  } else {
    participants.forEach(function (p) {
      const name = p.displayName || p.name || '';
      namesHtml += `
        <tr>
          <td><code style="font-size: 11px; word-break: break-all;">${p.userId}</code></td>
          <td>${name ? name : '<span style="color:#999;">Unnamed</span>'}</td>
          <td><span class="label ${(p.status === 'mining') ? 'label-success' : 'label-default'}">${p.status || 'idle'}</span>
            <small class="text-muted"> · ${p.blocksMined || 0} blocks</small></td>
        </tr>`;
    });
  }
  $('#nodeNamesList').html(namesHtml);
}
