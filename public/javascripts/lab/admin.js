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
          $('#difficultyLeading').val(restored.settings.difficultyLeading || 4);
          $('#difficultySecondary').val(restored.settings.difficultySecondary != null ? restored.settings.difficultySecondary : 8);
          $('#miningReward').val(restored.settings.miningRewardCoins || 10);
          $('#lockParameters').prop('checked', !!restored.settings.parametersLocked);
          updateDifficultyDisplay();
          updateSettingsDisplay(restored.settings);
        }
      }
    }

    // Apply any current slider values as initial settings (if no restore)
    const initialSettings = {
      difficultyLeading: parseInt($('#difficultyLeading').val()) || 4,
      difficultySecondary: (function () {
        var s = parseInt($('#difficultySecondary').val(), 10);
        return isNaN(s) ? 8 : s;
      })(),
      miningRewardCoins: parseInt($('#miningReward').val()) || 10,
      parametersLocked: $('#lockParameters').is(':checked')
    };
    relayState.updateSettings(initialSettings);

    // Ensure admin registers itself so lists + viz show the hub from the start (educational)
    if (relayState && typeof relayState.addOrUpdateParticipant === 'function') {
      relayState.addOrUpdateParticipant(adminUserId, 'admin', { displayName: 'Admin (Hub)', hashrate: 0, status: 'idle' });
    }

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
  }

  // Presence + initial-state are sent after initAsAdmin resolves (see above)

  // Listen for high-level events (coordinator handles most now)
  net.on('peer-joined', (msg) => {
    if (msg.from && String(msg.from).indexOf('probe-') === 0) {
      // Landing-page session probe — answer state but don't clutter UI
      return;
    }
    console.log('[ClientNet] Peer joined relay:', msg.from, msg.role);
    showToastNotification(`Miner joined: ${msg.from}`, 'info');

    if (relayState) {
      relayState.addOrUpdateParticipant(msg.from, msg.role || 'miner');
    }
    if (typeof renderClientParticipants === 'function') {
      renderClientParticipants();
    }
    if (typeof renderClientRelayChain === 'function') {
      renderClientRelayChain(); // refreshes chain + viz + stats too
    }
    // The coordinator already sent them the current state
  });

  net.on('admin-settings-updated', (msg) => {
    console.log('[ClientNet] Settings update received on admin:', msg);
  });

  // Re-render our own view when we (or the coordinator) accept a new block
  net.on('block-accepted', (msg) => {
    if (typeof renderClientRelayChain === 'function') {
      setTimeout(() => renderClientRelayChain(), 20);
    }
    // Strong persistence on every accepted block
    if (relayState && net && net.roomCode) {
      Persistence.saveAdminState(net.roomCode, relayState.getFullState());
    }
  });

  net.on('transaction-accepted', (msg) => {
    const payload = msg.payload || msg;
    // Ensure hub state is current (coordinator already added); refresh projector lists
    if (typeof renderClientParticipants === 'function') renderClientParticipants();
    if (typeof renderClientRelayChain === 'function') renderClientRelayChain();
    const n = (payload && payload.pendingTransactions && payload.pendingTransactions.length) ||
      (relayState && relayState.pendingTransactions && relayState.pendingTransactions.length) || 0;
    showToastNotification('Transaction in mempool (' + n + ' pending)', 'info');
  });

  // Basic hashrate reporting (from test peers or future real participants)
  net.on('hashrate-report', (msg) => {
    const payload = msg.payload || msg;
    const uid = payload.userId || msg.from;
    const hashrate = payload.hashrate;
    if (relayState && uid) {
      relayState.updateHashrate(uid, hashrate);
      if (typeof renderClientParticipants === 'function') renderClientParticipants();
    }
  });
  net.on('hashrate-update', (msg) => {
    const payload = msg.payload || msg;
    const uid = payload.userId || msg.from;
    const hashrate = payload.hashrate;
    if (relayState && uid) {
      relayState.updateHashrate(uid, hashrate);
      if (typeof renderClientParticipants === 'function') renderClientParticipants();
    }
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
    if (result && result.accepted) {
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
}

function setupEventHandlers() {
  // Difficulty sliders
  $('#difficultyLeading').on('input', function() {
    updateDifficultyDisplay();
  });
  
  $('#difficultySecondary').on('input', function() {
    updateDifficultyDisplay();
  });
  
  // Update Settings Button
  $('#updateSettingsBtn').click(function() {
    const selectedMode = $('#networkModeSelect').val() || 'admin-relay';
    const newSettings = {
      difficultyLeading: parseInt($('#difficultyLeading').val()),
      difficultySecondary: parseInt($('#difficultySecondary').val()),
      miningRewardCoins: parseInt($('#miningReward').val()),
      networkMode: selectedMode,
      parametersLocked: $('#lockParameters').is(':checked')
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

    // Client-relay only
    console.log('[ClientNet] Broadcasting settings via admin relay:', newSettings);

    if (relayState && typeof relayState.updateSettings === 'function') {
      relayState.updateSettings(newSettings);
    }

    if (coordinator && typeof coordinator.broadcastSettings === 'function') {
      coordinator.broadcastSettings(newSettings);
    } else if (net) {
      net.send('admin-settings-updated', newSettings);
    }

    // Strong persistence on settings change
    if (relayState && net && net.roomCode) {
      Persistence.saveAdminState(net.roomCode, relayState.getFullState());
    }

    showToastNotification('Settings broadcast to peers (client relay)', 'success');
    updateSettingsDisplay(newSettings);
  });
  
  // Network toggle
  $('#toggleNetworkBtn').click(function() {
    const isPaused = $(this).data('paused') || false;
    const willPause = !isPaused;
    $(this).text(willPause ? 'Resume Network' : 'Pause Network');
    $(this).data('paused', willPause);
    if (net) {
      net.send('toggle-network', { paused: willPause });
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
    const blocksBack = parseInt($('#teamAttackBlocksBack').val()) || 2;
    if (confirm('Initiate Team 51% attack simulation going back ' + blocksBack + ' blocks?')) {
      if (net) {
        net.send('start-team-attack', { blocksBack });
        $('#teamAttackStats').show();
        showToastNotification('Team attack broadcast (client relay)', 'success');
      }
    }
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
    </div>
    <button id="proposeForkBtn" class="btn btn-warning btn-block">Propose Hard Fork</button>
  `);
  
  $('#proposeForkBtn').click(function(e) {
    e.preventDefault();
    const height = parseInt($('#forkHeight').val()) || 10;
    const name = $('#forkName').val() || 'Hard Fork';
    if (confirm('Propose ' + name + ' at block ' + height + '?')) {
      if (net) {
        net.send('propose-hard-fork', { height, name });
        showToastNotification('Hard fork broadcast (client relay)', 'success');
      }
    }
  });

  // === Client-relay testing helper button ===
  const $netPanel = $('#updateSettingsBtn').closest('.panel-body');
  if ($netPanel.length) {
      $netPanel.append(`
        <div style="margin-top:14px; padding-top:10px; border-top:1px solid #eee;">
          <button id="openTestPeerBtn" class="btn btn-info btn-sm btn-block">Open Test Miner Tab</button>
          <small class="text-muted">Opens a miner page for this room. Use a second browser or phone for a true classroom test.</small>
        </div>
      `);

      $('#openTestPeerBtn').on('click', function() {
        const rc = (window.LabPaths && LabPaths.getSessionIdFromLocation()) || (window.location.pathname.split('/').pop() || '');
        const code = String(rc).toUpperCase();
        localStorage.setItem('joinCode_' + code, code);
        if (!localStorage.getItem('userId_' + code)) {
          localStorage.setItem('userId_' + code, 'test-miner-' + Date.now().toString(36));
        }
        localStorage.setItem('networkingMode_' + code, networkMode || 'admin-relay');
        const url = (window.LabPaths && LabPaths.labUrl)
          ? LabPaths.labUrl('participate', code)
          : ('/lab/participate/' + code);
        window.open(url, '_blank');
      });
    }
}

function updateDifficultyDisplay() {
  const leading = parseInt($('#difficultyLeading').val());
  const secondary = parseInt($('#difficultySecondary').val());
  
  $('#difficultyLeadingValue').text(leading);
  $('#difficultySecondaryValue').text(secondary.toString(16).toUpperCase());
}

// Legacy loadBlockchainState removed (client-relay only now uses renderClientRelayChain)

function updateBlockchainView(mainChain, orphans, participants) {
  const allBlocks = [...mainChain];
  const mainHashes = new Set(mainChain.map(b => b.hash));
  if (orphans && orphans.length > 0) {
    allBlocks.push(...orphans);
  }
  
  if (allBlocks.length === 0) {
    $('#blockchainView').html('<p class="text-muted">No blocks yet</p>');
    return;
  }

  const CD = window.ChainDisplay;
  const nameLookup = CD ? CD.buildParticipantNameLookup(participants || []) : {};
  const fmtAddr = (addr) => (CD ? CD.formatChainParticipantHtml(addr, nameLookup) : `<code>${addr || ''}</code>`);

  const byIndex = {};
  let maxIndex = 0;
  for (const b of allBlocks) {
    if (!byIndex[b.index]) byIndex[b.index] = [];
    if (!byIndex[b.index].find(existing => existing.hash === b.hash)) {
      byIndex[b.index].push(b);
    }
    if (b.index > maxIndex) maxIndex = b.index;
  }

  let html = '<div style="display: flex; flex-direction: column; width: 100%;">';

  for (let i = 0; i <= maxIndex; i++) {
    if (!byIndex[i]) continue;
    
    html += `<div style="display: flex; justify-content: center; flex-wrap: wrap; gap: 15px; margin-bottom: 0;">`;
    
    for (const block of byIndex[i]) {
      const isMain = mainHashes.has(block.hash);
      const panelClass = isMain ? (i === maxIndex ? 'panel-success' : 'panel-primary') : 'panel-warning';
      const label = isMain ? '' : '<span class="label label-warning pull-right">FORK</span>';
      
      let txHtml = `${block.transactions ? block.transactions.length : 0}`;
      if (block.transactions && block.transactions.length > 0) {
        const txId = `tx_${block.hash}`;
        const displayStyle = openTxPanels.has(txId) ? 'block' : 'none';
        txHtml += ` <button class="btn btn-xs btn-default" onclick="toggleTransactions('${txId}')">View Details</button>`;
        txHtml += `<div id="txDetails_${txId}" style="display:${displayStyle}; margin-top: 10px; max-height: 150px; overflow-y: auto;">`;
        txHtml += `<table class="table table-condensed"><thead><tr><th>From</th><th>To</th><th>Amt</th></tr></thead><tbody>`;
        for (const tx of block.transactions) {
          txHtml += `<tr><td>${fmtAddr(tx.from)}</td><td>${fmtAddr(tx.to)}</td><td>${tx.amount}</td></tr>`;
        }
        txHtml += `</tbody></table></div>`;
      }

      const forkBadge = (block.forkId && block.forkId !== 'classic') ? `<span class="label label-info pull-right" style="margin-right: 5px;">${block.forkId.toUpperCase()}</span>` : '';
      const minerId = block.miner != null ? block.miner : '';
      html += `<div style="display: flex; flex-direction: column; align-items: center; flex: 1 1 300px; max-width: 100%;">`;
      html += `
      <div class="panel ${panelClass}" style="width: 100%; margin-bottom: 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
        <div class="panel-heading" style="padding: 8px 15px;">
          <strong>Block #${block.index}</strong> ${label} ${forkBadge}
          <div class="pull-right text-muted small" style="margin-top: 2px;">${new Date(block.timestamp).toLocaleTimeString()}</div>
        </div>
        <div class="panel-body" style="padding: 10px 15px;">
          <dl class="dl-horizontal" style="margin-bottom: 0;">
            <dt style="width: 80px;">Hash</dt><dd style="margin-left: 90px;"><code style="font-size: 10px; word-break: break-all;">${block.hash.substring(0, 16)}...</code></dd>
            <dt style="width: 80px;">Prev Hash</dt><dd style="margin-left: 90px;"><code style="font-size: 10px; word-break: break-all;">${block.previousHash.substring(0, 16)}...</code></dd>
            <dt style="width: 80px;">Miner</dt><dd style="margin-left: 90px;">${fmtAddr(minerId)}</dd>
            <dt style="width: 80px;">Nonce</dt><dd style="margin-left: 90px;">${block.nonce}</dd>
            <dt style="width: 80px;">Txs</dt><dd style="margin-left: 90px;">${txHtml}</dd>
          </dl>
        </div>
      </div>
      `;
      
      if (i < maxIndex) {
        const children = (byIndex[i+1] || []).filter(b => b.previousHash === block.hash);
        if (children.length > 0) {
          let hasFork = false;
          for (const child of children) {
            if (!mainHashes.has(child.hash)) hasFork = true;
          }
          const arrowColor = hasFork || !isMain ? '#f0ad4e' : '#bbb';
          
          html += `<div style="text-align: center; margin-top: 5px; margin-bottom: 5px; color: ${arrowColor}; height: 20px;">`;
          if (children.length === 1) {
            html += `<i class="glyphicon glyphicon-arrow-down"></i>`;
          } else if (children.length === 2) {
            html += `<i class="glyphicon glyphicon-arrow-down" style="display: inline-block; transform: translateX(-15px) rotate(30deg);"></i>`;
            html += `<i class="glyphicon glyphicon-arrow-down" style="display: inline-block; transform: translateX(15px) rotate(-30deg);"></i>`;
          } else {
            const step = 60 / (children.length - 1);
            for (let c = 0; c < children.length; c++) {
              const angle = 30 - (c * step);
              const transX = -angle * 0.5;
              html += `<i class="glyphicon glyphicon-arrow-down" style="display: inline-block; transform: translateX(${transX}px) rotate(${angle}deg); margin: 0 2px;"></i>`;
            }
          }
          html += `</div>`;
        } else {
          html += `<div style="height: 30px;"></div>`;
        }
      } else {
        html += `<div style="height: 5px;"></div>`;
      }
      
      html += `</div>`;
    }
    html += `</div>`;
  }
  html += '</div>';
  
  $('#blockchainView').html(html);
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
  $('#adminDifficultyLeading').text(settings.difficultyLeading);
  $('#adminDifficultySecondary').text('0x' + settings.difficultySecondary.toString(16).toUpperCase());
  $('#adminMiningReward').text(settings.miningRewardCoins + ' coins');
  $('#adminParams').html(settings.parametersLocked ? 
    '<span class="label label-danger">Locked</span>' : 
    '<span class="label label-success">Unlocked</span>'
  );

  // Auto-sync the sliders to match the server defaults on first load
  if (!initialSettingsLoaded) {
    $('#difficultyLeading').val(settings.difficultyLeading);
    $('#difficultySecondary').val(settings.difficultySecondary);
    $('#miningReward').val(settings.miningRewardCoins);
    $('#networkModeSelect').val(settings.networkMode || 'simulated-p2p');
    $('#lockParameters').prop('checked', settings.parametersLocked);
    updateDifficultyDisplay();
    initialSettingsLoaded = true;
  }
}

function playBlockMinedAnimation() {
  // Play a subtle animation
  const $view = $('#blockchainView');
  $view.fadeOut(100).fadeIn(100);
}

// === Render the blockchain from relayState (canonical + competing miner forks) ===
function renderClientRelayChain() {
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

  // Update participants table from relay state
  renderClientParticipants();

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
        return {
          userId: p.userId || p.id,
          name: p.displayName || p.name || String(p.userId || '').substring(0, 8),
          status: p.status || (p.role === 'admin' ? 'idle' : 'mining'),
          chainHeight: p.blocksMined || 0,
          hashrate: p.hashrate || 0,
          address: p.userId,
          role: p.role || 'miner'
        };
      });
      const peerAssignments = new Map();
      // Admin-hosted: star topology around the instructor hub
      const center = vizMiners.find(function (m) {
        return m.role === 'admin' || /admin/i.test(m.userId || '') || /admin/i.test(m.name || '');
      }) || vizMiners[0];
      if (center && vizMiners.length > 1) {
        vizMiners.forEach(function (m) {
          if (m.userId !== center.userId) {
            peerAssignments.set(m.userId, [center.userId]);
          }
        });
      }
      viz.updateTopology(vizMiners, peerAssignments);

      const tip = chain[chain.length - 1];
      if (tip && tip.miner && tip.miner !== 'genesis' && typeof viz.blockFound === 'function') {
        // Only pulse when the tip miner changes (avoid constant yellow flash)
        if (viz._lastTipMiner !== tip.miner) {
          viz._lastTipMiner = tip.miner;
          viz.blockFound(tip.miner);
        }
      }
    } catch (e) {
      console.warn('[Viz] updateTopology non-fatal:', e && e.message);
    }
  }
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
    participants.forEach(p => {
      const roleClass = p.role === 'wallet' ? 'label-info' : (p.role === 'admin' ? 'label-warning' : 'label-success');
      const roleText = p.role === 'wallet' ? 'Wallet' : (p.role === 'admin' ? 'Admin' : 'Miner');
      const mined = p.blocksMined != null ? p.blocksMined : (p.minedBlocks || 0);
      const name = p.displayName || p.name || '';
      const nameHtml = name ? `<strong style="display:block;margin-bottom:2px;">${name}</strong>` : '';
      html += `
        <tr>
          <td>
            ${nameHtml}
            <code style="font-size: 11px; word-break: break-all;">${p.userId}</code>
          </td>
          <td><span class="label ${roleClass}">${roleText}</span></td>
          <td><strong>${mined}</strong></td>
          <td>${p.balance || 0} coins</td>
          <td><span class="text-success">${p.status || 'idle'}</span> <small>(${(p.hashrate || 0).toFixed(0)} H/s)</small></td>
        </tr>
      `;
    });
  }

  $('#participantsList').html(html);

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
