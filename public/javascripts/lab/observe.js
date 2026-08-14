/**
 * Blockchain Lab Observer View
 * Real-time view of the blockchain network
 */

let sessionId = null;
let userId = null;
let openTxPanels = new Set();
let networkPaused = false;
let lastToastKey = '';
let lastToastAt = 0;
let toastQueue = [];
let toastBusy = false;

// Client-relay networking (only mode)
let networkMode = null;
let net = null;
let socket = null; // prevent any stray legacy references

function showToastNotification(message, type = 'info', durationMs) {
  const now = Date.now();
  const key = String(type || 'info') + '|' + String(message || '');
  if (key === lastToastKey && now - lastToastAt < 8000) return;
  lastToastKey = key;
  lastToastAt = now;
  const isResume = /resumed/i.test(String(message || ''));
  const hold = durationMs != null
    ? durationMs
    : (type === 'warning' ? 8000 : (isResume || type === 'success' ? 6000 : 4000));
  const item = { message: message, type: type, hold: hold };
  if (isResume) toastQueue.unshift(item);
  else toastQueue.push(item);
  drainToastQueue();
}

function drainToastQueue() {
  if (toastBusy || !toastQueue.length) return;
  toastBusy = true;
  const next = toastQueue.shift();
  $('#toastNotification').remove();
  const bgColor = next.type === 'success' ? '#28a745' : next.type === 'error' ? '#dc3545' : next.type === 'warning' ? '#d97706' : '#17a2b8';
  const toast = $(`
    <div id="toastNotification" class="lab-toast lab-toast-${next.type}" style="
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
      ${next.message}
    </div>
  `);
  $('body').append(toast);
  setTimeout(function () {
    toast.fadeOut(300, function () {
      $(this).remove();
      toastBusy = false;
      drainToastQueue();
    });
  }, next.hold);
}

// Add CSS animation for toast
if (!$('#toastStyles').length) {
  $('<style id="toastStyles">@keyframes slideIn { from { transform: translateX(450px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }</style>').appendTo('head');
}

$(document).ready(function() {
  sessionId = (window.LabPaths && LabPaths.getSessionIdFromLocation()) || '';
  if (window.LabPaths && LabPaths.persistChainFlavor) {
    LabPaths.persistChainFlavor(sessionId, LabPaths.getChainFlavor());
  }
  if (window.LabPaths && typeof LabPaths.applyClassroomTheme === 'function') {
    LabPaths.applyClassroomTheme();
  }
  
  // Prefer ?uid= from landing Join (minted per click). Never read
  // localStorage userId_SESSION_wallet — that reused Wallet 1 on a new tab.
  // A missing uid must NOT mint another student (observe.html?session=CVV1U8
  // without uid created user_iu5u4pz0i, then user_yifueuw8c, then user_m4fs468vo).
  var joinUid = '';
  try {
    joinUid = (new URLSearchParams(window.location.search || '')).get('uid') || '';
  } catch (eUid) {}
  if (window.LabPaths && typeof LabPaths.allocateTabUserId === 'function') {
    userId = LabPaths.allocateTabUserId(sessionId, 'wallet', { uid: joinUid, mint: false });
  } else if (joinUid) {
    userId = joinUid;
  } else {
    try { userId = sessionStorage.getItem('labUserId_' + sessionId) || ''; } catch (e) {}
  }
  if (!userId) {
    if (window.LabPaths && typeof LabPaths.labUrl === 'function') {
      window.location.replace(LabPaths.labUrl('index', sessionId));
    } else {
      window.location.replace('/lab?join=' + encodeURIComponent(sessionId || ''));
    }
    return;
  }
  if (window.LabPaths && typeof LabPaths.pinUidInLocation === 'function') {
    LabPaths.pinUidInLocation(userId);
  } else {
    try { sessionStorage.setItem('labUserId_' + sessionId, userId); } catch (ePin) {}
  }
  if (window.LabPaths && typeof LabPaths.enforceBoundRolePage === 'function') {
    if (userId && LabPaths.enforceBoundRolePage('wallet', sessionId, userId)) return;
  }
  if (window.LabPaths && LabPaths.persistNodeRole) {
    LabPaths.persistNodeRole(sessionId, userId, 'wallet');
  }
  
  // Display user address
  $('#yourAddress').text(userId);
  const earlyName = loadLocalWalletName();
  if (earlyName && $('#nodeName').length) $('#nodeName').val(earlyName);
  
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
    persistLocalWalletName(nodeName);
    if (net) {
      if (typeof net.setDisplayName === 'function') net.setDisplayName(nodeName);
      else if (net.transport) net.transport.nodeDisplayName = nodeName;
      net.send('node-name-changed', { userId: userId, name: nodeName, role: 'wallet' });
      setTimeout(function () {
        if (net) net.send('node-name-changed', { userId: userId, name: nodeName, role: 'wallet' });
      }, 800);
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
      adoptObserverHubChain(state.chain, state);
      populateObserverUIFromState({
        chain: window._observerChain,
        orphans: [],
        participants: state.participants || [],
        pendingTransactions: state.pendingTransactions,
        networkStats: state.networkStats,
        newHeight: state.newHeight != null ? state.newHeight : state.tipIndex,
        hubHeight: state.tipIndex != null ? state.tipIndex : (state.chainHeight != null ? state.chainHeight : state.newHeight)
      });
      return;
    }
    // Compact tip-extension (common over MQTT): only the new block is sent
    if (state.block) {
      if (!window._observerChain) window._observerChain = [];
      const tip = window._observerChain[window._observerChain.length - 1];
      if (state.isFork) {
        // Hub rejected this as main — keep it off the wallet canonical view
        const orphans = (state.orphans || []).concat([state.block]);
        const hubH = state.tipIndex != null ? state.tipIndex : state.newHeight;
        populateObserverUIFromState({
          chain: window._observerChain,
          orphans: [],
          participants: state.participants || [],
          pendingTransactions: state.pendingTransactions,
          networkStats: state.networkStats,
          newHeight: hubH,
          hubHeight: hubH
        });
        return;
      }
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
        : (state.tipIndex != null ? state.tipIndex : Math.max(0, window._observerChain.length - 1));
      const HeightFn = window.RelayBlockchainState && RelayBlockchainState.resolveOverviewHeight;
      const overviewH = (typeof HeightFn === 'function')
        ? HeightFn(window._observerChain, {
          tipIndex: derivedHeight,
          newHeight: derivedHeight,
          hubHeight: derivedHeight,
          networkStats: state.networkStats
        }, window._observerHubHeight)
        : Math.max(Number(derivedHeight) || 0, Number(window._observerHubHeight) || 0);
      const stats = Object.assign({}, state.networkStats || {}, {
        blockHeight: overviewH
      });
      populateObserverUIFromState({
        chain: window._observerChain,
        orphans: [],
        participants: state.participants || [],
        pendingTransactions: state.pendingTransactions,
        networkStats: stats,
        newHeight: overviewH,
        hubHeight: overviewH
      });
    } else {
      populateObserverUIFromState(state);
    }
  });

  net.on('block-gossip', function () {
    // Gossip is not hub-canonical. Do not request-state on every peer block —
    // that flood delivered truncated snapshots and rolled the wallet copy back.
  });

  net.on('initial-state', (msg) => {
    const state = msg.payload || msg;
    if (window.LabSessionProbe) LabSessionProbe.notifyHubSeen();
    if (state.chain && Array.isArray(state.chain) && state.chain.length) {
      adoptObserverHubChain(state.chain, state);
    }
    if (typeof state.networkPaused === 'boolean') networkPaused = state.networkPaused;
    populateObserverUIFromState(Object.assign({}, state, {
      chain: window._observerChain || state.chain,
      orphans: [],
      hubHeight: state.tipIndex != null ? state.tipIndex : state.chainHeight
    }));
  });

  net.on('transport-reconnected', function () {
    if (net) net.send('request-state', { from: userId });
  });

  net.on('network-toggled', function (msg) {
    const { paused } = msg.payload || msg;
    networkPaused = !!paused;
    showToastNotification(
      networkPaused ? 'Network paused by admin — transactions blocked' : 'Network resumed by admin',
      networkPaused ? 'warning' : 'success',
      networkPaused ? 8000 : 6500
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
    const tipIndex = p.tipIndex != null ? Number(p.tipIndex) : Number(p.chainHeight);
    const localTip = window._observerChain && window._observerChain.length
      ? window._observerChain[window._observerChain.length - 1]
      : null;
    const localH = localTip && localTip.index != null ? Number(localTip.index) : -1;
    if (!isNaN(tipIndex)) {
      // Presence carries the live hub tip every ~4s. Paint Overview from it
      // so a compact last-20 copy cannot leave height ~20 behind (22 vs 45).
      paintObserverOverviewHeight(window._observerChain, { tipIndex: tipIndex, hubHeight: tipIndex });
      if (tipIndex > localH && net) {
        net.send('request-state', { from: userId });
      }
    }
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
      pendingTransactions: window._observerPending || [],
      replaceParticipants: true
    });
  });

  const joinCode = localStorage.getItem('joinCode_' + sessionId) || sessionId;
  const savedName = loadLocalWalletName();
  if (savedName && typeof net.setDisplayName === 'function') net.setDisplayName(savedName);
  net.joinRoom(joinCode, userId, 'wallet').then(() => {
    console.log('[ObserveNet] Joined relay room as observer');
    $('#blockchainView').html('<p class="text-muted">Connected to relay hub. Waiting for initial chain state from admin...</p>');
    if (savedName) {
      net.send('node-name-changed', { userId: userId, name: savedName, role: 'wallet' });
    }
    // Explicitly request the state
    net.send('request-state', { from: userId });
    window.addEventListener('pagehide', function () {
      try { if (net) net.send('peer-left', { from: userId }); } catch (e) {}
    });
  });

  window.BlockchainLabNet = net;
}

function walletNameStorageKey() {
  return 'nodeName_' + sessionId + '_' + userId;
}

function loadLocalWalletName() {
  try {
    return sessionStorage.getItem(walletNameStorageKey())
      || localStorage.getItem(walletNameStorageKey())
      || '';
  } catch (e) {
    return '';
  }
}

function persistLocalWalletName(name) {
  const n = String(name || '').trim();
  try {
    sessionStorage.setItem(walletNameStorageKey(), n);
    localStorage.setItem(walletNameStorageKey(), n);
  } catch (e) {}
}

function adoptObserverHubChain(incoming, meta) {
  meta = meta || {};
  const local = window._observerChain || [];
  const Merge = window.RelayBlockchainState && RelayBlockchainState.mergeCanonicalCopy;
  if (typeof Merge === 'function') {
    const merged = Merge(local, incoming, {
      truncated: !!meta.chainTruncated,
      tipHash: meta.tipHash,
      tipIndex: meta.tipIndex != null ? meta.tipIndex : meta.chainHeight,
      chainHeight: meta.chainHeight != null ? meta.chainHeight : meta.newHeight
    });
    window._observerChain = merged.chain;
  } else {
    const newTip = incoming[incoming.length - 1];
    const sameTip = newTip && local.some(function (b) { return b && b.hash === newTip.hash; });
    if (!(meta.chainTruncated && local.length > incoming.length && sameTip)) {
      window._observerChain = incoming.slice();
    }
  }
  const h = (meta.tipIndex != null) ? Number(meta.tipIndex)
    : (meta.chainHeight != null ? Number(meta.chainHeight)
      : (meta.newHeight != null ? Number(meta.newHeight) : null));
  if (h != null && !isNaN(h)) {
    if (window._observerHubHeight == null || h >= window._observerHubHeight) {
      window._observerHubHeight = h;
    }
  }
  return window._observerChain;
}

/** Merge roster so chain re-paints keep miner names when payloads omit them. */
function rememberObserverParticipants(parts, opts) {
  opts = opts || {};
  if (!Array.isArray(parts) || !parts.length) {
    return window._observerParticipants || [];
  }
  const byId = new Map();
  const incomingIds = new Set();
  parts.forEach(function (p) {
    const id = p && (p.userId || p.address || p.id);
    if (id && String(id).indexOf('probe-') !== 0) incomingIds.add(String(id));
  });
  const treatAsFull = !!opts.replace || incomingIds.size >= 2;
  if (!treatAsFull) {
    (window._observerParticipants || []).forEach(function (p) {
      const id = p && (p.userId || p.address || p.id);
      if (id) byId.set(String(id), p);
    });
  } else {
    (window._observerParticipants || []).forEach(function (p) {
      const id = p && (p.userId || p.address || p.id);
      if (id && incomingIds.has(String(id))) byId.set(String(id), p);
    });
  }
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
    const participants = rememberObserverParticipants(state.participants || [], {
      replace: !!state.replaceParticipants
    });
    const orphans = [];
    if (Array.isArray(state.pendingTransactions)) {
      window._observerPending = state.pendingTransactions.slice();
    }

    if (state.adminSettings && typeof updateAdminSettings === 'function') {
      updateAdminSettings(state.adminSettings);
    }

    // Prefer hub tip / copy tip. Never trust a stale networkStats.blockHeight
    // that is behind the chain already on screen (join showed 0 while #17 existed;
    // later Overview oscillated 22↔28 while the copy was at 31+).
    const ResolveFn = window.RelayBlockchainState && RelayBlockchainState.resolveOverviewHeight;
    const stats = Object.assign({}, state.networkStats || {});
    const overviewH = (typeof ResolveFn === 'function')
      ? ResolveFn(chain, {
        tipIndex: state.tipIndex != null ? state.tipIndex : state.chainHeight,
        chainHeight: state.chainHeight,
        hubHeight: state.hubHeight,
        newHeight: state.newHeight,
        networkStats: stats
      }, window._observerHubHeight)
      : Math.max(
        Number(stats.blockHeight) || 0,
        Number(state.hubHeight) || 0,
        Number(state.newHeight) || 0,
        Number(window._observerHubHeight) || 0,
        (chain.length && chain[chain.length - 1] && chain[chain.length - 1].index != null)
          ? Number(chain[chain.length - 1].index) : 0
      );
    stats.blockHeight = overviewH;
    if (overviewH != null && !isNaN(Number(overviewH))) {
      window._observerHubHeight = Math.max(Number(window._observerHubHeight) || 0, Number(overviewH));
    }

    if (typeof updateNetworkStats === 'function') {
      updateNetworkStats({
        networkStats: stats,
        participants: participants,
        chain: chain,
        hubHeight: window._observerHubHeight
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

    const hubHeight = (state.hubHeight != null)
      ? Number(state.hubHeight)
      : (stats.blockHeight != null ? Number(stats.blockHeight) : window._observerHubHeight);
    if (hubHeight != null && !isNaN(Number(hubHeight))) {
      window._observerHubHeight = Math.max(Number(window._observerHubHeight) || 0, Number(hubHeight));
    }

    if (typeof updateBlockchainView === 'function') {
      updateBlockchainView(chain, orphans, participants);
    }

    if (userId && participants.length) {
      const me = participants.find(p => p.address === userId || p.userId === userId);
      if (me && me.balance !== undefined && me.balance !== null) {
        $('#yourBalance').text(me.balance);
      }
      const localName = loadLocalWalletName();
      if (me && localName) {
        me.name = localName;
        me.displayName = localName;
      }
      const $nodeName = $('#nodeName');
      if ($nodeName.length && !$nodeName.is(':focus')) {
        if (localName) {
          $nodeName.val(localName);
        } else if (me && (me.name || me.displayName)) {
          $nodeName.val(me.displayName || me.name);
        }
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
        openTxPanels: openTxPanels,
        hubHeight: window._observerHubHeight
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

function paintObserverOverviewHeight(chain, meta) {
  const ResolveFn = window.RelayBlockchainState && RelayBlockchainState.resolveOverviewHeight;
  const CopyFn = window.RelayBlockchainState && RelayBlockchainState.copyTipIndex;
  const copyTip = (typeof CopyFn === 'function') ? CopyFn(chain) : null;
  let height = (typeof ResolveFn === 'function')
    ? ResolveFn(chain, meta || {}, window._observerHubHeight)
    : (copyTip != null ? copyTip : window._observerHubHeight);
  if (height == null) height = 0;
  height = Math.max(Number(height) || 0, Number(window._observerHubHeight) || 0, Number(copyTip) || 0);
  window._observerHubHeight = height;
  $('#blockHeight').text(height);
  return height;
}

function updateNetworkStats(blockchain) {
  const stats = blockchain.networkStats || {};
  paintObserverOverviewHeight(blockchain.chain, {
    tipIndex: blockchain.hubHeight != null ? blockchain.hubHeight : window._observerHubHeight,
    hubHeight: blockchain.hubHeight,
    networkStats: stats
  });
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
        <span class="participant-row-actions pull-right">${copyBtn}${sendBtn}</span>
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
