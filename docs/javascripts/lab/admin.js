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
  $('#sessionCode').after('<span style="display: block; margin-top: 10px; text-align: center;"><strong>Your Role: </strong><span class="label label-danger" style="font-size: 1em;">Admin</span></span>');

  // Client-relay badge
  $('#sessionCode').after(
    `<span style="display:block; margin-top:6px; text-align:center;">
       <span class="label label-success" style="font-size:0.9em;" id="networkModeBadge">Admin-hosted (WebRTC Hub)</span>
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
  networkViz = new NetworkVisualization('#networkVisualizationSvg');

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
          $('#difficultyLeading').val(restored.settings.difficultyLeading || 3);
          $('#difficultySecondary').val(restored.settings.difficultySecondary || 15);
          $('#miningReward').val(restored.settings.miningRewardCoins || 10);
          $('#lockParameters').prop('checked', !!restored.settings.parametersLocked);
          updateDifficultyDisplay();
          updateSettingsDisplay(restored.settings);
        }
      }
    }

    // Apply any current slider values as initial settings (if no restore)
    const initialSettings = {
      difficultyLeading: parseInt($('#difficultyLeading').val()) || 3,
      difficultySecondary: parseInt($('#difficultySecondary').val()) || 15,
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
    // Also early defaults for stats
    $('#blockHeight').text('0');
    $('#participantCount').text('0');
    $('#totalHashrate').text('0 H/s');
    $('#lastBlockTime').text('0s');

    // Broadcast initial state so any already-joined peers (or late joiners) get the chain immediately
    if (net) {
      const state = relayState.getSanitizedStateForNewPeer();
      net.send('initial-state', state);
      console.log('[ClientNet] Broadcast initial state on admin init');
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

  // Announce admin presence on the channel
  net.send('admin-presence', { roomCode, adminUserId });

  // Listen for high-level events (coordinator handles most now)
  net.on('peer-joined', (msg) => {
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
      net.send('block-accepted', { block, minerId });
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
      : 'Admin-hosted (WebRTC Hub)';
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

// === NEW: Render the blockchain from relayState (client-relay mode only) ===
function renderClientRelayChain() {
  if (!relayState || !relayState.chain || relayState.chain.length === 0) {
    $('#blockchainView').html('<p class="text-muted">Waiting for first blocks...</p>');
    return;
  }

  const chain = relayState.chain;
  const participants = Array.from(relayState.participants.values());

  const CD = window.ChainDisplay;
  const nameLookup = CD ? CD.buildParticipantNameLookup(participants) : {};
  const fmtAddr = (addr) => (CD ? CD.formatChainParticipantHtml(addr, nameLookup) : `<code>${addr || ''}</code>`);

  let html = '<div style="display: flex; flex-direction: column; width: 100%;">';

  chain.forEach((block, idx) => {
    const isTip = idx === chain.length - 1;
    const panelClass = isTip ? 'panel-success' : 'panel-primary';

    let txHtml = `${block.transactions ? block.transactions.length : 0}`;
    if (block.transactions && block.transactions.length > 0) {
      const txId = `tx_${block.hash}`;
      const displayStyle = openTxPanels.has(txId) ? 'block' : 'none';
      txHtml += ` <button class="btn btn-xs btn-default" onclick="toggleTransactions('${txId}')">View Details</button>`;
      txHtml += `<div id="txDetails_${txId}" style="display:${displayStyle}; margin-top: 10px; max-height: 150px; overflow-y: auto;">`;
      txHtml += `<table class="table table-condensed"><thead><tr><th>From</th><th>To</th><th>Amt</th></tr></thead><tbody>`;
      block.transactions.forEach(tx => {
        txHtml += `<tr><td>${fmtAddr(tx.from)}</td><td>${fmtAddr(tx.to)}</td><td>${tx.amount}</td></tr>`;
      });
      txHtml += `</tbody></table></div>`;
    }

    const minerId = block.miner || '';
    html += `
      <div style="display: flex; justify-content: center; margin-bottom: 8px;">
        <div class="panel ${panelClass}" style="width: 100%; max-width: 520px; margin-bottom: 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <div class="panel-heading" style="padding: 6px 12px;">
            <strong>Block #${block.index}</strong>
            <div class="pull-right text-muted small">${new Date(block.timestamp).toLocaleTimeString()}</div>
          </div>
          <div class="panel-body" style="padding: 8px 12px; font-size: 12px;">
            <div><strong>Hash:</strong> <code style="font-size: 10px;">${(block.hash || '').substring(0, 24)}...</code></div>
            <div><strong>Prev:</strong> <code style="font-size: 10px;">${(block.previousHash || '').substring(0, 24)}...</code></div>
            <div><strong>Miner:</strong> ${fmtAddr(minerId)}</div>
            <div><strong>Nonce:</strong> ${block.nonce || 0} &nbsp;&nbsp; <strong>Txs:</strong> ${txHtml}</div>
          </div>
        </div>
      </div>
    `;
  });

  html += '</div>';
  $('#blockchainView').html(html);

  // Also update stats
  $('#blockHeight').text(relayState.networkStats.blockHeight || chain.length - 1);
  $('#participantCount').text(relayState.participants.size);
  $('#totalHashrate').text((relayState.networkStats.totalHashrate || 0).toFixed(0) + ' H/s');
  if (relayState.networkStats.lastBlockTime) {
    const secondsAgo = Math.floor((Date.now() - relayState.networkStats.lastBlockTime) / 1000);
    $('#lastBlockTime').text(secondsAgo + 's');
  }

  // Update participants table from relay state
  renderClientParticipants();

  // Feed live data to network visualization (only if D3 viz loaded and has the method)
  if (window.networkViz && typeof window.networkViz.updateTopology === 'function') {
    try {
      const participantsArr = Array.from(relayState.participants.values());
      const vizMiners = participantsArr.map(p => ({
        userId: p.userId || p.id,
        name: p.displayName || p.name || (p.userId || '').substring(0, 8),
        status: p.status || 'mining',
        chainHeight: p.blocksMined || 0,
        hashrate: p.hashrate || 0,
        address: p.userId
      }));
      const peerAssignments = new Map();
      const center = vizMiners.find(m => /admin/i.test(m.userId || '')) || vizMiners[0];
      if (center && vizMiners.length > 1) {
        vizMiners.forEach(m => {
          if (m.userId !== center.userId) {
            peerAssignments.set(m.userId, [center.userId]);
          }
        });
      }
      window.networkViz.updateTopology(vizMiners, peerAssignments);
      // also mark latest miner as 'found' briefly for visual if we have tip
      const tip = chain[chain.length-1];
      if (tip && tip.miner && typeof window.networkViz.blockFound === 'function') {
        window.networkViz.blockFound(tip.miner);
      }
    } catch (e) {
      console.warn('[Viz] updateTopology non-fatal:', e && e.message);
    }
  }
}

// Render participants list from relayState (client-relay mode)
function renderClientParticipants() {
  if (!relayState) return;

  const participants = Array.from(relayState.participants.values());
  let html = '';

  if (participants.length === 0) {
    html = '<tr><td colspan="5" class="text-center text-muted">No miners or wallets yet</td></tr>';
  } else {
    participants.forEach(p => {
      const roleClass = p.role === 'wallet' ? 'label-info' : 'label-success';
      const roleText = p.role === 'wallet' ? 'Wallet' : 'Miner';
      html += `
        <tr>
          <td>
            <code style="font-size: 11px; word-break: break-all;">${p.userId}</code>
          </td>
          <td><span class="label ${roleClass}">${roleText}</span></td>
          <td><strong>${p.blocksMined || 0}</strong></td>
          <td>${p.balance || 0} coins</td>
          <td><span class="text-success">${p.status || 'idle'}</span> <small>(${(p.hashrate || 0).toFixed(0)} H/s)</small></td>
        </tr>
      `;
    });
  }

  $('#participantsList').html(html);
}
