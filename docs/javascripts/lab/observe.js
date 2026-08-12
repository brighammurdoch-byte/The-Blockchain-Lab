/**
 * Blockchain Lab Observer View
 * Real-time view of the blockchain network
 */

let sessionId = null;
let userId = null;
let openTxPanels = new Set();
let networkPaused = false;

// Client-relay networking (only mode)
let networkMode = null;
let net = null;
let socket = null; // prevent any stray legacy references

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
  sessionId = (window.LabPaths && LabPaths.getSessionIdFromLocation()) || '';
  
  // Get userId from localStorage (set by landing.js when joining)
  userId = localStorage.getItem('userId_' + sessionId);
  if (!userId) {
    // Fallback: generate new if not found (for direct navigation)
    userId = 'user_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('userId_' + sessionId, userId);
  }
  
  // Display user address
  $('#yourAddress').text(userId);
  
  // Display session code (from storage or the one passed from server/URL)
  const joinCode = localStorage.getItem('joinCode_' + sessionId) || sessionId;
  $('#sessionCode').text(joinCode);
  $('#sessionCode').after('<span style="display: block; margin-top: 10px; text-align: center;"><strong>Your Role: </strong><span class="label label-info" style="font-size: 1em;">Wallet</span></span>');

  // Early defaults to avoid loading appearance
  $('#yourBalance').text('0');
  $('#blockHeight').text('0');

  $('#sessionCode').after('<span style="display:block; margin-top:6px; text-align:center;"><span class="label label-info" style="font-size:0.85em;">Browser Relay</span></span>');

  // Always client-relay
  networkMode = localStorage.getItem('networkingMode_' + joinCode) || 'admin-relay';

  // Block invalid / inactive session codes (direct URL protection)
  if (window.LabSessionProbe && typeof LabSessionProbe.requireActiveSession === 'function') {
    LabSessionProbe.requireActiveSession(joinCode).catch(function () {
      /* redirect handled by probe */
    });
  }

  initClientSideNetworkingForObserver(networkMode);
  
  // Load initial state via client-relay (handled in init)
  // Set up event handlers
  setupEventHandlers();
});

function setupEventHandlers() {
  // Handle transaction form
  $('#transactionForm').on('submit', function(e) {
    e.preventDefault();
    
    const toUserId = $('#recipientAddress').val().trim();
    const amount = parseFloat($('#transactionAmount').val());
    
    if (!toUserId || !amount || amount <= 0) {
      showToastNotification('Please enter a valid recipient address and amount', 'error');
      return;
    }
    
    if (net) {
      if (networkPaused) {
        showToastNotification('Network is paused by admin — transactions blocked', 'warning');
        return;
      }
      const tx = {
        from: userId,
        to: toUserId,
        amount: amount,
        timestamp: Date.now()
      };
      net.send('transaction-submitted', { transaction: tx });
      showToastNotification('Transaction submitted via relay (no server)!', 'success');
      $('#recipientAddress').val('');
      $('#transactionAmount').val('');
      // The admin will include it in next state broadcast; for now just note
    } else {
      showToastNotification('No relay connection', 'error');
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

  $(document).on('click', '.use-recipient-btn', function () {
    const addr = $(this).data('address') || $(this).attr('data-address');
    if (!addr) return;
    $('#recipientAddress').val(addr);
    $('#transactionAmount').focus();
    showToastNotification('Recipient set — enter an amount and send', 'info');
  });

  $('#setNodeNameBtn').on('click', function() {
    const nodeName = $('#nodeName').val().trim();
    if (nodeName.length > 50) {
      showToastNotification('Display name must be 50 characters or less', 'error');
      return;
    }
    if (net) {
      net.send('node-name-changed', { userId: userId, name: nodeName });
      showToastNotification(nodeName ? 'Display name saved!' : 'Display name cleared', 'success');
    } else {
      showToastNotification('Not connected yet — try again in a moment', 'error');
    }
  });

  $('#nodeName').on('keypress', function(e) {
    if (e.which === 13) {
      e.preventDefault();
      $('#setNodeNameBtn').trigger('click');
    }
  });
}

// Legacy initSocket removed (client-relay only)
  // (the function body with socket.on etc. was here and has been pruned)

// Client-relay networking for observers (lightweight)
function initClientSideNetworkingForObserver(mode) {
  if (!window.NetworkManager) {
    console.error('[ObserveNet] NetworkManager missing');
    return;
  }
  net = new NetworkManager(mode);

  // Attach listeners BEFORE join, so we don't miss the response 'initial-state'
  net.on('admin-settings-updated', (msg) => {
    const s = msg.payload || msg;
    if (s.networkMode && net && typeof net.setRoutingMode === 'function') {
      net.setRoutingMode(s.networkMode);
      localStorage.setItem('networkingMode_' + (net.roomCode || sessionId), s.networkMode);
    }
    if (typeof updateAdminSettings === 'function') updateAdminSettings(s);
  });

  net.on('block-accepted', (msg) => {
    const state = msg.payload || msg;
    if (state.chain && Array.isArray(state.chain) && state.chain.length > 0) {
      window._observerChain = state.chain.slice();
      populateObserverUIFromState({
        chain: window._observerChain,
        orphans: state.orphans || [],
        participants: state.participants || [],
        pendingTransactions: state.pendingTransactions,
        networkStats: state.networkStats,
        newHeight: state.newHeight
      });
      return;
    }
    // Compact tip-extension (common over MQTT): only the new block is sent
    if (state.block) {
      if (!window._observerChain) window._observerChain = [];
      const tip = window._observerChain[window._observerChain.length - 1];
      if (!tip || state.block.previousHash === tip.hash) {
        window._observerChain.push(state.block);
      } else if (tip.hash === state.block.hash) {
        // Already at tip (duplicate delivery)
      } else {
        // Orphan without full chain — request sync
        net.send('request-state', { from: userId });
        return;
      }
      const derivedHeight = (state.newHeight != null)
        ? state.newHeight
        : Math.max(0, window._observerChain.length - 1);
      const stats = Object.assign({}, state.networkStats || {}, {
        blockHeight: (state.networkStats && state.networkStats.blockHeight != null)
          ? state.networkStats.blockHeight
          : derivedHeight
      });
      populateObserverUIFromState({
        chain: window._observerChain,
        participants: state.participants || [],
        pendingTransactions: state.pendingTransactions,
        networkStats: stats,
        newHeight: derivedHeight
      });
    } else {
      populateObserverUIFromState(state);
    }
  });

  net.on('block-gossip', (msg) => {
    const block = (msg.payload && msg.payload.block) || msg.block;
    if (!block) return;
    if (!window._observerChain) window._observerChain = [];
    const tip = window._observerChain[window._observerChain.length - 1];
    if (tip && tip.hash === block.hash) {
      /* already have it */
    } else if (!tip || block.previousHash === tip.hash) {
      window._observerChain.push(block);
    } else {
      net.send('request-state', { from: userId });
      return;
    }
    populateObserverUIFromState({
      chain: window._observerChain.slice(),
      networkStats: { blockHeight: Math.max(0, window._observerChain.length - 1) },
      newHeight: Math.max(0, window._observerChain.length - 1)
    });
  });

  net.on('initial-state', (msg) => {
    const state = msg.payload || msg;
    if (window.LabSessionProbe) LabSessionProbe.notifyHubSeen();
    if (state.chain) window._observerChain = state.chain.slice();
    if (typeof state.networkPaused === 'boolean') networkPaused = state.networkPaused;
    populateObserverUIFromState(state);
  });

  net.on('network-toggled', function (msg) {
    const { paused } = msg.payload || msg;
    networkPaused = !!paused;
    showToastNotification(
      networkPaused ? 'Network paused by admin — transactions blocked' : 'Network resumed by admin',
      networkPaused ? 'warning' : 'success'
    );
  });
  net.on('toggle-network', function (msg) {
    const { paused } = msg.payload || msg;
    networkPaused = !!paused;
  });

  net.on('admin-presence', function (msg) {
    if (window.LabSessionProbe) LabSessionProbe.notifyHubSeen();
    const p = (msg && (msg.payload || msg)) || {};
    if (typeof p.networkPaused === 'boolean') networkPaused = p.networkPaused;
    else if (typeof p.paused === 'boolean') networkPaused = p.paused;
  });

  net.on('peer-hello', function (msg) {
    if (msg && msg.isAdmin && window.LabSessionProbe) LabSessionProbe.notifyHubSeen();
  });

  net.on('transaction-accepted', function (msg) {
    const payload = msg.payload || msg;
    const pending = payload.pendingTransactions;
    if (Array.isArray(pending)) {
      populateObserverUIFromState({
        chain: window._observerChain || [],
        pendingTransactions: pending,
        participants: payload.participants || []
      });
    } else if (payload.transaction || (payload.from && payload.to)) {
      const tx = payload.transaction || payload;
      const current = (window._observerPending || []).slice();
      current.push(tx);
      window._observerPending = current;
      populateObserverUIFromState({
        chain: window._observerChain || [],
        pendingTransactions: current,
        participants: []
      });
    }
  });

  net.on('participants-roster', function (msg) {
    const payload = msg.payload || msg;
    const parts = payload.participants || [];
    if (!parts.length) return;
    populateObserverUIFromState({
      chain: window._observerChain || [],
      participants: parts,
      pendingTransactions: window._observerPending || []
    });
  });

  const joinCode = localStorage.getItem('joinCode_' + sessionId) || sessionId;
  net.joinRoom(joinCode, userId, 'wallet').then(() => {
    console.log('[ObserveNet] Joined relay room as observer');
    $('#blockchainView').html('<p class="text-muted">Connected to relay hub. Waiting for initial chain state from admin...</p>');
    // Explicitly request the state
    net.send('request-state', { from: userId });
  });

  window.BlockchainLabNet = net;
}

/** Merge roster so chain re-paints keep miner names when payloads omit them. */
function rememberObserverParticipants(parts) {
  if (!Array.isArray(parts) || !parts.length) {
    return window._observerParticipants || [];
  }
  const byId = new Map();
  (window._observerParticipants || []).forEach(function (p) {
    const id = p && (p.userId || p.address || p.id);
    if (id) byId.set(String(id), p);
  });
  parts.forEach(function (p) {
    if (!p) return;
    const id = p.userId || p.address || p.id;
    if (!id) return;
    const prev = byId.get(String(id)) || {};
    const merged = Object.assign({}, prev, p);
    const prevName = (prev.displayName || prev.name || '').trim();
    const nextName = (p.displayName || p.name || '').trim();
    if (!nextName && prevName) {
      merged.name = prev.name || prevName;
      merged.displayName = prev.displayName || prevName;
    } else if (nextName) {
      merged.name = p.name || nextName;
      merged.displayName = p.displayName || nextName;
    }
    byId.set(String(id), merged);
  });
  window._observerParticipants = Array.from(byId.values());
  return window._observerParticipants;
}

function populateObserverUIFromState(state) {
  if (!state) return;
  try {
    const chain = state.chain || [];
    const participants = rememberObserverParticipants(state.participants || []);
    const orphans = state.orphans || [];
    if (Array.isArray(state.pendingTransactions)) {
      window._observerPending = state.pendingTransactions.slice();
    }

    if (state.adminSettings && typeof updateAdminSettings === 'function') {
      updateAdminSettings(state.adminSettings);
    }

    // Prefer hub networkStats, then newHeight, then derive from local chain length.
    // Compact MQTT block-accepted often omits full chain but still carries newHeight.
    const derivedHeight = Math.max(0, chain.length > 0 ? chain.length - 1 : 0);
    const stats = Object.assign({}, state.networkStats || {});
    if (stats.blockHeight == null) {
      if (state.newHeight != null) stats.blockHeight = state.newHeight;
      else if (chain.length > 0) stats.blockHeight = derivedHeight;
    }

    if (typeof updateNetworkStats === 'function') {
      updateNetworkStats({
        networkStats: stats,
        participants: participants,
        chain: chain
      });
    } else if (stats.blockHeight != null) {
      $('#blockHeight').text(stats.blockHeight);
    }

    if (typeof updateParticipantList === 'function') {
      updateParticipantList({ participants: participants });
    }

    if (typeof updatePendingTransactions === 'function') {
      updatePendingTransactions({
        pendingTransactions: state.pendingTransactions || window._observerPending || [],
        participants: participants
      });
    }

    if (typeof updateBlockchainView === 'function') {
      updateBlockchainView(chain, orphans, participants);
    }

    if (userId && participants.length) {
      const me = participants.find(p => p.address === userId || p.userId === userId);
      if (me && me.balance !== undefined && me.balance !== null) {
        $('#yourBalance').text(me.balance);
      }
      const $nodeName = $('#nodeName');
      if ($nodeName.length && !$nodeName.is(':focus') && me && (me.name || me.displayName)) {
        $nodeName.val(me.displayName || me.name);
      }
    }
  } catch (e) {
    console.error('Error populating observer UI from relay state', e);
  }
}

function loadBlockchainState() {
  // no-op in client-relay mode; population handled via net messages in populateObserverUIFromState
}

function updateBlockchainView(mainChain, orphans, participants) {
  const parts = rememberObserverParticipants(participants || []);
  $('#blockchainView').css('background-color', '#fcfcfc').css('padding', '15px').css('border-radius', '4px');
  if (window.ChainDisplay && typeof ChainDisplay.renderChainHtml === 'function') {
    $('#blockchainView').html(
      ChainDisplay.renderChainHtml({
        mainChain: mainChain || [],
        orphans: orphans || [],
        participants: parts,
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
  let height = stats.blockHeight;
  if (height == null && Array.isArray(blockchain.chain) && blockchain.chain.length > 0) {
    height = Math.max(0, blockchain.chain.length - 1);
  }
  if (height == null) height = 0;
  $('#blockHeight').text(height);
  $('#participantCount').text(blockchain.participants ? blockchain.participants.length : 0);
  $('#totalHashrate').text((stats.totalHashrate || 0).toFixed(0) + ' H/s');

  if (stats.lastBlockTime) {
    const secondsAgo = Math.floor((Date.now() - stats.lastBlockTime) / 1000);
    $('#lastBlockTime').text(secondsAgo + 's ago');
  }
}

function updateParticipantList(blockchain) {
  const participants = (blockchain.participants || []).filter(function (p) {
    const id = p.userId || p.address || p.id || '';
    return id && String(id).indexOf('probe-') !== 0;
  });
  let html = '';

  participants.forEach(p => {
    const addr = p.userId || p.address || p.id || '';
    const mined = p.blocksMined != null ? p.blocksMined : (p.minedBlocks || 0);
    const bal = p.balance != null ? p.balance : 0;
    const role = String(p.role || 'miner').toLowerCase();
    const roleLabel = (role === 'wallet' || role === 'observer')
      ? '<span class="label label-info">Wallet</span>'
      : (role === 'admin' || role === 'hub'
        ? '<span class="label label-warning">Admin</span>'
        : '<span class="label label-success">Miner</span>');
    const displayName = (p.displayName || p.name || '').trim();
    const nameHtml = displayName
      ? `<strong style="display: block; margin-top: 4px;">${String(displayName).replace(/</g, '&lt;')}</strong>`
      : '';
    const isSelf = addr && userId && addr === userId;
    const selfBadge = isSelf ? ' <span class="label label-default">You</span>' : '';
    const sendBtn = (!isSelf && addr)
      ? `<button type="button" class="btn btn-xs btn-primary use-recipient-btn" data-address="${addr}" title="Fill send form">Send to</button>`
      : '';
    const copyBtn = addr
      ? `<button type="button" class="btn btn-xs btn-default copy-btn" data-clipboard-text="${addr}" title="Copy address">Copy</button>`
      : '';

    html += `<li class="list-group-item" style="padding: 8px 10px;">
      <div>${roleLabel}${selfBadge}
        <span class="pull-right">${copyBtn}${sendBtn ? ' ' + sendBtn : ''}</span>
      </div>
      ${nameHtml}
      <div style="margin-top: 4px; clear: both;">
        <code style="font-size: 10px; word-break: break-all; display: block;">${addr}</code>
      </div>
      <span class="text-muted small">${mined} blocks · ${bal} coins</span>
    </li>`;
  });

  if (participants.length === 0) {
    html = '<li class="list-group-item text-muted"><em>Waiting for miners and wallets...</em></li>';
  }

  $('#participantList').html(html);
}

function updatePendingTransactions(blockchain) {
  const transactions = blockchain.pendingTransactions || [];
  const CD = window.ChainDisplay;
  const nameLookup = CD ? CD.buildParticipantNameLookup(blockchain.participants || []) : {};
  const fmtAddr = (addr) => (CD ? CD.formatChainParticipantHtml(addr, nameLookup) : `<code>${addr || ''}</code>`);
  let html = '';

  transactions.forEach(tx => {
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

function updateAdminSettings(settings) {
  $('#adminDifficultyLeading').text(settings.difficultyLeading || 'N/A');
  const secondary = settings.difficultySecondary !== undefined ? settings.difficultySecondary : 8;
  $('#adminDifficultySecondary').text('0x' + secondary.toString(16).toUpperCase());
  $('#adminMiningReward').text((settings.miningRewardCoins || 0) + ' coins');
  $('#adminParams').html(settings.parametersLocked ? 
    '<span class="label label-danger">Locked</span>' : 
    '<span class="label label-success">Unlocked</span>'
  );
}

function updateMiningStatus() {
  // This function would update the display showing which miners are working on which blocks
  // and display consensus status
  // For now, just refresh the view
  loadBlockchainState();
}
