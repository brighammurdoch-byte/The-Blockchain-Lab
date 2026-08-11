/**
 * Blockchain Lab Participant (Miner) Interface
 * Handle mining blocks and sending transactions
 */

let sessionId = null;
let userId = null;
let isMining = false;
let cpuLimitPercent = 20;
let miningWorker = null;
let openTxPanels = new Set();
let originalValidatorCode = '';
let localChainTipHash = null;
let isColluding = false;
let collusionTipHash = null;
let collusionHeight = 0;
let collusionTransactions = [];
let lastKnownAdminSettings = null;
let myForkChoice = 'classic';
let pendingForkHeight = null;
let seenBlocks = new Set(); // Prevent infinite gossip loops
let rtcPeerConnections = {}; // WebRTC connections
let rtcDataChannels = {}; // WebRTC data channels
let pendingDemoCode = null; // Store admin-triggered demo code
let demoCodeApplyAtBlock = null; // Block height when demo code should apply
let isSyncingChain = false; // Prevent multiple concurrent sync requests
let lastFailedSyncHeight = 0; // Prevent infinite sync loops on incompatible hard forks
const DEBUG_MODE = localStorage.getItem('blockchainLabDebug') === 'true'; // Enable via console: localStorage.setItem('blockchainLabDebug', 'true')

// Client-relay networking (only mode)
let networkMode = null;
let net = null;

// Controlled logging that respects DEBUG_MODE
function debugLog(...args) {
  if (DEBUG_MODE) {
    console.log('[BlockchainLab]', ...args);
  }
}

function debugWarn(...args) {
  if (DEBUG_MODE) {
    console.warn('[BlockchainLab]', ...args);
  }
}

/** Restart the mining loop on the current hub tip without flipping isMining off. */
function remineOnCanonicalTip() {
  if (!isMining || isColluding) return;
  if (miningWorker) {
    try { miningWorker.postMessage({ command: 'stop' }); } catch (e) {}
    try { miningWorker.terminate(); } catch (e) {}
    miningWorker = null;
  }
  fetchDataAndMine();
}

/**
 * Replace local chain with the hub's canonical chain and remine if the tip moved
 * away from what we were hashing.
 * @returns {boolean} whether the tip hash changed
 */
function applyCanonicalChain(chain, opts) {
  opts = opts || {};
  if (!chain || !Array.isArray(chain) || chain.length === 0) return false;

  const oldTip = window.lastRelayedChain && window.lastRelayedChain.length
    ? window.lastRelayedChain[window.lastRelayedChain.length - 1]
    : null;
  const newTip = chain[chain.length - 1];
  const tipChanged = !oldTip || !newTip || oldTip.hash !== newTip.hash;

  window.lastRelayedChain = chain.slice();
  chain.forEach(function (b) {
    if (b && b.hash) seenBlocks.add(b.hash);
  });

  try {
    const parts = opts.participants || [];
    updateParticipantBlockchainView({ chain: window.lastRelayedChain }, parts);
    updateNetworkBlockchainView(window.lastRelayedChain, [], parts);
    if (opts.networkStats || parts.length) {
      updateNetworkStats({
        networkStats: opts.networkStats || {},
        participants: parts
      });
    }
    if (parts.length) updateParticipantList({ participants: parts });
    const me = parts.find(function (p) {
      return p.address === userId || p.userId === userId;
    });
    if (me) {
      if (me.balance !== undefined) $('#yourBalance').text(me.balance);
      if (me.blocksMined !== undefined) $('#blocksMined').text(me.blocksMined);
      else if (me.minedBlocks !== undefined) $('#blocksMined').text(me.minedBlocks);
    }
  } catch (e) {
    console.error('Error applying canonical chain UI', e);
  }

  if (newTip) {
    $('#blockchainView').html(
      '<div class="alert alert-success">Chain tip #' + newTip.index +
      ' (' + String(newTip.hash).substring(0, 16) + '…) miner=' +
      (newTip.miner || '?') + '</div>'
    );
    $('#blockHeight').text(newTip.index);
  }

  // Always remine after a hub sync while mining — cancels private optimistic forks
  if (opts.remine !== false && isMining) {
    remineOnCanonicalTip();
  }

  return tipChanged;
}

// Canonicalize object for consistent hashing (sorted keys)
function canonicalizeObject(obj) {
  if (Array.isArray(obj)) {
    return obj.map(item => canonicalizeObject(item));
  } else if (obj !== null && typeof obj === 'object') {
    const sorted = {};
    Object.keys(obj).sort().forEach(key => {
      sorted[key] = canonicalizeObject(obj[key]);
    });
    return sorted;
  }
  return obj;
}

// Require CryptoJS for hashing - fail loudly if not available
if (typeof CryptoJS === 'undefined') {
  throw new Error('CryptoJS library is required but not loaded. Please ensure sha256.js is included in the page.');
}

// Define the sha256 hash function using CryptoJS
window.sha256 = function(data) {
  if (typeof CryptoJS === 'undefined') {
    throw new Error('CryptoJS became unavailable during execution. This should not happen.');
  }
  return CryptoJS.SHA256(data).toString();
};

// Apply participant's custom validator code to their local node
function applyCustomValidator(code) {
  if (code.includes('WALLET DOUBLE SPEND SCRIPT')) return true; // Ignore wallet attack scripts
  
  try {
    let browserCode = code
      .replace(/const crypto = require\(['"]crypto['"]\);/g, `
        const crypto = {
          createHash: function() {
            return {
              data: '',
              update: function(d) { this.data += (typeof d === 'string' ? d : JSON.stringify(d)); return this; },
              digest: function() { return window.sha256(this.data); }
            };
          }
        };
      `)
      .replace(/module\.exports\s*=\s*BlockValidator;?/g, '')
      + '\nreturn new BlockValidator();';
    
    window.customValidator = new Function(browserCode)();
    return true;
  } catch (e) {
    return e.message;
  }
}

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
  sessionId = (window.LabPaths && LabPaths.getSessionIdFromLocation()) || window.location.pathname.split('/').pop();
  
  // Set address and session code as early as possible from localStorage or URL to avoid "Loading..." flash/stuck
  let earlyUserId = localStorage.getItem('userId_' + sessionId);
  if (!earlyUserId) {
    earlyUserId = 'user_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('userId_' + sessionId, earlyUserId);
  }
  userId = earlyUserId;
  $('#yourAddress').text(userId);

  const earlyJoinCode = localStorage.getItem('joinCode_' + sessionId) || sessionId;
  $('#sessionCode').text(earlyJoinCode);
  $('#sessionCode').after('<span style="display: block; margin-top: 10px; text-align: center;"><strong>Your Role: </strong><span class="label label-success" style="font-size: 1em;">Miner</span></span>');

  // Early defaults for stats to avoid loading look
  $('#blockHeight').text('0');
  $('#participantCount').text('0');
  $('#totalHashrate').text('0 H/s');
  $('#difficultyLevel').text('N/A');
  $('#yourBalance').text('0');
  $('#blocksMined').text('0');
  $('#yourHashrate').text('0 H/s');

  // Always client-relay mode (admin-hosted by default; may switch to Full P2P via admin settings)
  networkMode = localStorage.getItem('networkingMode_' + earlyJoinCode) || 'admin-relay';
  console.log('[BlockchainLab Participant] Networking mode:', networkMode, 'room:', sessionId);

  initClientSideNetworkingForParticipant(networkMode);

  // Note about relay
  $('#blockchainView').prepend('<div class="alert alert-info small" id="networkModeNote" style="margin-bottom:8px">Connecting to instructor hub…</div>');
  $('#blockchainView').prepend('<div class="alert alert-warning small" id="connectionStatusNote" style="margin-bottom:8px; display:none;"></div>');

  // Block invalid / inactive session codes (direct URL protection)
  if (window.LabSessionProbe && typeof LabSessionProbe.requireActiveSession === 'function') {
    LabSessionProbe.requireActiveSession(earlyJoinCode).catch(function () {
      /* redirect handled by probe */
    });
  }

  // If hub is slow but session was verified on landing, seed local genesis so mining can continue
  setTimeout(function () {
    if (window.lastRelayedChain && window.lastRelayedChain.length > 0) return;
    var verified = window.LabSessionProbe && LabSessionProbe.wasRecentlyVerified(earlyJoinCode);
    if (!verified) return;
    seedLocalGenesisChain();
    $('#connectionStatusNote').show().html(
      'No response from instructor yet. Mining uses a local genesis tip — keep the <strong>admin tab open</strong> on the same lab URL. ' +
      'On phones, use the QR/share link from the admin page (GitHub Pages), not localhost.'
    );
    showToastNotification('Waiting for instructor hub — seeded local genesis so you can mine', 'warning');
  }, 2500);

  loadValidatorCode();
  
  // Set up event handlers
  setupEventHandlers();
  
  // Note: Auto-refresh now happens via WebSocket block-broadcast events only
  // This eliminates constant polling and reduces server load
  
  
  // Initialize CPU usage display to match default
  $('#cpuUsage').val(cpuLimitPercent);
  $('#cpuUsageValue').text(cpuLimitPercent);

  // Display user info (already set above)
  // $('#yourAddress').text(userId);

  // Add fork control panel placeholder
  $('#blockchainView').before(`
    <div id="forkControlPanel" style="display:none; margin-bottom: 15px; padding: 15px; background-color: #fff8e1; border: 1px solid #ffecb3; border-radius: 4px;">
      <h4><i class="glyphicon glyphicon-random"></i> Fork Control</h4>
      <p>A network fork is active. Choose which chain to follow:</p>
      <div class="btn-group" role="group">
        <button type="button" id="btnFollowClassic" class="btn btn-primary">Classic Chain</button>
        <button type="button" id="btnFollowNew" class="btn btn-default">New Chain</button>
      </div>
    </div>
  `);

  // No server polling in client-relay mode

});

// Legacy initSocket removed (client-relay only)
let socket = null; // ensure no ReferenceError from any remaining legacy paths
  
  function handleGossipBlock(block, minerId) {
    if (minerId === userId) return; // Ignore our own block
    if (seenBlocks.has(block.hash)) return; // Deduplicate! Stop infinite gossip loop
    
    seenBlocks.add(block.hash);
    debugLog(`Received gossip block from ${minerId}: ${block.hash.substring(0, 16)}... Evaluating.`);

    // Track validator acceptance (broken validator = rejects everything)
    let validatorAccepts = true;
    let validatorReason = null;

    // Run custom validator if available
    if (window.customValidator) {
      if (window.customValidator._broken) {
        validatorAccepts = false;
        validatorReason = '❌ Broken validator';
        showToastNotification(`${validatorReason} rejected block #${block.index}`, 'error');
      } else {
        try {
          // Validate the hash matches the data
          const hashCheck = window.customValidator.validateBlockHash(block);
          if (!hashCheck) {
            validatorAccepts = false;
            validatorReason = 'Invalid block hash';
            showToastNotification(`❌ Validator rejected block hash!`, 'error');
          }
          // Validate difficulty
          else {
            const diffCheck = window.customValidator.validateDifficulty(block.hash, block.difficulty);
            if (diffCheck && diffCheck.valid === false) {
              validatorAccepts = false;
              validatorReason = diffCheck.reason || 'Difficulty validation failed';
              showToastNotification(`❌ Validator rejected block: ${validatorReason}`, 'error');
            }
          }
          // Validate all transactions inside the block
          if (validatorAccepts && block.transactions) {
            for (const tx of block.transactions) {
              const txCheck = window.customValidator.validateTransaction(tx, block.transactions);
              if (txCheck && txCheck.valid === false) {
                validatorAccepts = false;
                validatorReason = txCheck.reason || 'Transaction validation failed';
                showToastNotification(`❌ Validator rejected transaction: ${validatorReason}`, 'error');
                break;
              }
            }
          }
        } catch (e) {
          validatorAccepts = false;
          validatorReason = 'Validator crashed during validation';
          showToastNotification(`❌ ${validatorReason}!`, 'error');
        }
      }
    }

    // If we are on the collusion team and a fellow attacker found a block extending our secret chain
    // (Process this regardless of validator acceptance - collusion happens at network level)
    if (isColluding && block.previousHash === collusionTipHash) {
      collusionTipHash = block.hash;
      collusionHeight = block.index + 1;
      if (isMining) {
        stopMining();
        setTimeout(startMining, 100);
      }
    }

    // In client-relay mode, the admin hub has already accepted and is rebroadcasting.
    // We skip server-specific emits (add-to-personal-chain, process-peer-block, gossip-forward).
    // Local chain update happens below.
    // (Legacy real-p2p WebRTC path removed — mesh uses NetworkManager block-gossip.)
  }


// === NEW: Client-side (admin-relay) networking for participants/miners ===
function initClientSideNetworkingForParticipant(mode) {
  if (!window.NetworkManager) {
    console.error('[ParticipantNet] NetworkManager not loaded!');
    return;
  }

  net = new NetworkManager(mode);

  // Attach listeners BEFORE joinRoom so we catch the 'initial-state' response from admin
  // Wire the important events we used to get from socket
  net.on('admin-settings-updated', (msg) => {
    const settings = msg.payload || msg;
    debugLog('Settings updated via relay:', settings);
    lastKnownAdminSettings = normalizeAdminSettings(settings);

    if (settings.networkMode) {
      networkMode = settings.networkMode;
      localStorage.setItem('networkingMode_' + (net.roomCode || sessionId), networkMode);
      if (net && typeof net.setRoutingMode === 'function') {
        net.setRoutingMode(networkMode);
      }
      const note = networkMode === 'p2p'
        ? 'Full P2P mode — blocks gossip peer-to-peer; longest chain wins locally.'
        : 'Using Admin-hosted relay — keep the instructor tab open.';
      $('#networkModeNote').text(note);
      showToastNotification(networkMode === 'p2p' ? 'Switched to Full P2P mesh' : 'Switched to Admin-hosted hub', 'info');
    }

    // Update UI elements that the old 'settingsUpdated' handler touched
    if (settings.difficultyLeading !== undefined) {
      // Many places read from lastKnownAdminSettings or update displays
      $('#difficultyLevel').text(settings.difficultyLeading + ' + 0x' + (settings.difficultySecondary || 15).toString(16));
    }
    // Re-apply any mining parameter changes if mining
    if (isMining && miningWorker) {
      miningWorker.postMessage({ type: 'updateSettings', settings });
    }
  });

  net.on('block-gossip', (msg) => {
    const block = (msg.payload && msg.payload.block) || msg.block;
    const minerId = (msg.payload && msg.payload.minerId) || msg.from;
    const chain = (msg.payload && msg.payload.chain) || msg.chain;
    if (chain && Array.isArray(chain) && chain.length > 0) {
      applyCanonicalChain(chain, { remine: true });
      return;
    }
    if (!block) return;
    if (block.hash) seenBlocks.add(block.hash);
    try { handleGossipBlock(block, minerId || 'peer'); } catch (e) {}
    if (!window.lastRelayedChain) window.lastRelayedChain = [];
    const tip = window.lastRelayedChain[window.lastRelayedChain.length - 1];
    if (!tip || block.previousHash === tip.hash) {
      window.lastRelayedChain.push(block);
      remineOnCanonicalTip();
    }
    // Non-extending gossip without a full chain: ignore (wait for hub)
  });

  net.on('hard-fork-proposed', (msg) => {
    const { height, name } = msg.payload || msg;
    pendingForkHeight = height;
    // Trigger the existing fork UI flow
    showForkProposalModal(name, height);
  });

  net.on('team-attack-started', (msg) => {
    // Reuse existing handler logic if possible, or minimal version
    const data = msg.payload || msg;
    debugLog('Team attack started via relay', data);
    // For now, just notify
    showToastNotification('Team 51% attack simulation active on network', 'warning');
  });

  net.on('network-toggled', (msg) => {
    const { paused } = msg.payload || msg;
    if (paused && isMining) {
      stopMining();
      showToastNotification('Network paused by admin (via relay)', 'warning');
    }
  });

  net.on('block-accepted', (msg) => {
    const payload = msg.payload || msg;
    const block = payload.block;
    const minerId = payload.minerId;
    debugLog('Block accepted via relay from', minerId, {
      isFork: payload.isFork,
      reorg: payload.reorg,
      tipChanged: payload.tipChanged
    });
    $('#connectionStatusNote').hide();

    if (payload.chain && Array.isArray(payload.chain) && payload.chain.length > 0) {
      applyCanonicalChain(payload.chain, {
        participants: payload.participants || [],
        networkStats: payload.networkStats,
        remine: true
      });
      if (payload.reorg) {
        showToastNotification('Chain reorg — following longest chain', 'warning');
      } else if (payload.isFork) {
        showToastNotification('Your block was an orphan — mining on the winning tip', 'info');
      }
      return;
    }

    // Legacy single-block payload
    if (block) {
      if (block.hash) seenBlocks.add(block.hash);
      try { handleGossipBlock(block, minerId || 'relay-admin'); } catch (e) {}
      if (!window.lastRelayedChain) window.lastRelayedChain = [];
      const tip = window.lastRelayedChain[window.lastRelayedChain.length - 1];
      if (!tip || tip.hash === block.hash) {
        /* already at tip */
      } else if (block.previousHash === tip.hash) {
        window.lastRelayedChain.push(block);
        remineOnCanonicalTip();
      } else {
        // Stale/orphan without chain snapshot — ask hub for canonical state
        net.send('request-state', { from: userId });
      }
      try {
        updateParticipantBlockchainView({ chain: window.lastRelayedChain }, []);
        updateNetworkBlockchainView(window.lastRelayedChain, [], []);
      } catch (e) {}
    }
  });

  net.on('block-rejected', (msg) => {
    const payload = msg.payload || msg;
    debugWarn('Block rejected by hub', payload && payload.reason);
    if (payload && payload.chain && payload.chain.length) {
      applyCanonicalChain(payload.chain, { remine: true });
    } else {
      remineOnCanonicalTip();
      net.send('request-state', { from: userId });
    }
    showToastNotification(payload && payload.reason
      ? ('Block rejected: ' + payload.reason)
      : 'Block rejected — remine on hub tip', 'warning');
  });

  net.on('initial-state', (msg) => {
    const state = msg.payload || msg;
    if (window.LabSessionProbe) LabSessionProbe.notifyHubSeen();
    debugLog('Received initial state from admin relay', state);
    $('#connectionStatusNote').hide();
    $('#networkModeNote').text(
      networkMode === 'p2p'
        ? 'Full P2P mode — blocks gossip peer-to-peer.'
        : 'Connected to Admin-hosted relay — keep the instructor tab open.'
    );

    if (state.adminSettings) {
      lastKnownAdminSettings = normalizeAdminSettings(state.adminSettings);

      $('#difficultyLevel').text(
        (state.adminSettings.difficultyLeading || 3) + ' + 0x' +
        (state.adminSettings.difficultySecondary || 15).toString(16)
      );

      // Push latest difficulty to mining worker if running
      if (isMining && miningWorker && lastKnownAdminSettings) {
        miningWorker.postMessage({ type: 'updateSettings', settings: lastKnownAdminSettings });
      }
    }

    // If we received a real chain from the admin hub, feed it into local logic
    if (state.chain && Array.isArray(state.chain) && state.chain.length > 0) {
      applyCanonicalChain(state.chain, {
        participants: state.participants || [],
        networkStats: state.networkStats,
        remine: true
      });
      debugLog('Relayed chain length:', state.chain.length);

      try {
        const pend = state.pendingTransactions || [];
        const parts = state.participants || [];
        updatePendingTransactions({ pendingTransactions: pend, participants: parts });
        if (state.adminSettings) {
          updateDifficultyInfo(state.adminSettings);
        }
        const me = parts.find(p => p.address === userId || p.userId === userId);
        if (me && me.name) $('#nodeName').val(me.name);
      } catch (e) {
        console.error('Error updating participant UI from initial relayed state', e);
      }
    }

    // loadBlockchainState(); // no-op in relay
  });

  net.on('admin-presence', (msg) => {
    if (window.LabSessionProbe) LabSessionProbe.notifyHubSeen();
    debugLog('Admin is present via relay:', msg.adminUserId);
  });

  net.on('peer-hello', (msg) => {
    if (msg && msg.isAdmin && window.LabSessionProbe) LabSessionProbe.notifyHubSeen();
  });

  // Now join (after listeners attached)
  const joinCode = localStorage.getItem('joinCode_' + sessionId) || sessionId;
  net.joinRoom(joinCode, userId, 'miner').then(() => {
    console.log('[ParticipantNet] Joined client-relay room:', joinCode, 'as', userId);
    showToastNotification('Connected via browser relay (no server)', 'success');
    $('#blockchainView').html('<p class="text-muted">Connected to relay hub. Waiting for initial chain state from admin...</p>');
    // Explicitly request the state in case the automatic peer-joined didn't trigger it
    net.send('request-state', { from: userId });
  });

  // Expose for debugging
  window.BlockchainLabNet = net;
}

// Parse unified diff format and display with colors
function parseDiffAndDisplay(diffText, oldCode, newCode) {
  if (!diffText) return;
  
  const lines = diffText.split('\n');
  let html = '<div style="border: 1px solid #dee2e6; border-radius: 4px; overflow: hidden;">';
  
  let contextLines = 0;
  
  for (let line of lines) {
    if (line.startsWith('---') || line.startsWith('+++')) {
      html += `<div class="diff-header">${escapeHtml(line)}</div>`;
    } else if (line.startsWith('@@')) {
      html += `<div class="diff-header">${escapeHtml(line)}</div>`;
      contextLines = 0;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      html += `<div class="diff-line removed">- ${escapeHtml(line.substring(1))}</div>`;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      html += `<div class="diff-line added">+ ${escapeHtml(line.substring(1))}</div>`;
    } else if (line.startsWith(' ')) {
      // Context lines - show first few to understand context
      if (contextLines < 2) {
        html += `<div class="diff-line context">  ${escapeHtml(line.substring(1))}</div>`;
        contextLines++;
      }
    } else if (line.trim() !== '') {
      // Other content - treat as context
      html += `<div class="diff-line context">  ${escapeHtml(line)}</div>`;
    }
  }
  
  html += '</div>';
  
  $('#diffContent').html(html);
  $('#codeDiffViewer').show();
}

// Simple HTML escape function
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// Switch to validator code tab
function switchToValidatorCodeTab() {
  $('a[href="#tabCode"]').tab('show');
  window.scrollTo(0, 0);
}

// ============ WEBRTC ENGINE ============
function setupWebRTC() {
  teardownWebRTC();
  if (socket) {
    socket.emit('request-webrtc-peers', { sessionId });
  }
  // In admin-relay, webrtc is not the primary; skip if no socket
}

function teardownWebRTC() {
  Object.values(rtcDataChannels).forEach(dc => dc.close());
  Object.values(rtcPeerConnections).forEach(pc => pc.close());
  rtcPeerConnections = {};
  rtcDataChannels = {};
}

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  rtcPeerConnections[peerId] = pc;
  pc.onicecandidate = e => {
    if (e.candidate && socket) socket.emit('webrtc-ice', { target: peerId, candidate: e.candidate });
  };
  pc.ondatachannel = e => setupDataChannel(peerId, e.channel);
  return pc;
}

function setupDataChannel(peerId, dc) {
  rtcDataChannels[peerId] = dc;
  dc.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'block') handleGossipBlock(data.block, data.minerId);
    } catch(err) { console.error('WebRTC parse error', err); }
  };
  dc.onopen = () => showToastNotification('WebRTC True P2P connected!', 'success');
}

async function createWebRTCOffer(peerId) {
  const pc = createPeerConnection(peerId);
  const dc = pc.createDataChannel('blockchain');
  setupDataChannel(peerId, dc);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  if (socket) socket.emit('webrtc-offer', { target: peerId, offer: offer });
}

function broadcastViaWebRTC(block, minerId) {
  const message = JSON.stringify({ type: 'block', block, minerId });
  Object.values(rtcDataChannels).forEach(dc => {
    if (dc.readyState === 'open') dc.send(message);
  });
}

function setupEventHandlers() {
  // CPU usage slider
  $('#cpuUsage').on('input', function() {
    cpuLimitPercent = $(this).val();
    $('#cpuUsageValue').text(cpuLimitPercent);
  });
  
  // Mining buttons
  $('#mineBtn').click(function() {
    startMining();
  });
  
  $('#stopMineBtn').click(function() {
    stopMining();
  });

  // Node name handler
  $('#setNodeNameBtn').click(function() {
    const nodeName = $('#nodeName').val().trim();
    if (!nodeName) {
      showToastNotification('Please enter a node name', 'error');
      return;
    }
    
    if (nodeName.length > 50) {
      showToastNotification('Node name must be 50 characters or less', 'error');
      return;
    }
    
    // Emit node name change via relay if possible
    if (net) {
      net.send('node-name-changed', { userId: userId, name: nodeName });
    } else if (socket) {
      socket.emit('node-name-changed', {
        sessionId: sessionId,
        userId: userId,
        name: nodeName
      });
    }
    
    showToastNotification('Node name updated!', 'success');
  });
  
  // Allow Enter key to set node name
  $('#nodeName').keypress(function(e) {
    if (e.which === 13) {
      e.preventDefault();
      $('#setNodeNameBtn').click();
    }
  });
  $('#transactionForm').submit(function(e) {
    e.preventDefault();
    
    const recipientAddress = $('#recipientAddress').val().trim();
    const amount = parseFloat($('#transactionAmount').val());
    
    if (!recipientAddress || !amount || amount <= 0) {
      showToastNotification('Please enter a valid recipient address and amount', 'error');
      return;
    }
    
    sendTransaction(recipientAddress, amount);
  });

  // Validator Code Editor Handlers
  $('#submitValidatorCodeBtn').click(function() {
    const modifiedCode = $('#validatorCodeEditor').val();
    
    // Apply to local node immediately
    const compileResult = applyCustomValidator(modifiedCode);
    if (compileResult !== true) {
      showToastNotification('Validator Compile Error: ' + compileResult, 'error');
      window.customValidator = { _broken: true }; // Intentionally break their miner
    } else {
      showToastNotification('Custom validator rules applied to your node!', 'success');
    }
    
  });
  
  $('#resetValidatorCodeBtn').click(function() {
    if (confirm('Are you sure you want to reset to the original validation code?')) {
      $('#validatorCodeEditor').val(originalValidatorCode);
      applyCustomValidator(originalValidatorCode);
      $('#executeDoubleSpendBtn').hide();
      $('#submitValidatorCodeBtn').show();
      showToastNotification('Validator reset to original code!', 'success');
    }
  });
  
  $('#btnSetupDoubleSpend').click(function() {
    const walletCode = `// --- WALLET DOUBLE SPEND SCRIPT ---
// The blockchain strictly prevents double spending in the mempool.
// To bypass this, we must send Transaction 1 to the network normally,
// and secretly mine Transaction 2 into a private fork!

// 1. Put the first address here (Main Chain Target)
const target1 = "REPLACE_WITH_ADDRESS_1";

// 2. Put the second address here (Secret Fork Target)
const target2 = "REPLACE_WITH_ADDRESS_2";

// 3. Enter the amount to double spend
const amount = 50;

// When you click Execute, your wallet will:
// A) Broadcast Target 1 to the honest network
// B) Start secretly mining Target 2
executeDoubleSpendAttack(target1, target2, amount);
`;
    $('#validatorCodeEditor').val(walletCode);
    $('#submitValidatorCodeBtn').hide();
    
    if ($('#executeDoubleSpendBtn').length === 0) {
      $('<button class="btn btn-danger" id="executeDoubleSpendBtn">Execute Double Spend Attack</button>')
        .insertAfter('#validatorCodeEditor');
        
      $('#executeDoubleSpendBtn').click(function() {
        try {
          window.executeDoubleSpendAttack = function(t1, t2, amt) {
            sendTransaction(t1, amt);
            // In client-relay mode, simulate the chain tip from relayed state or just set
            collusionTipHash = window.lastRelayedChain && window.lastRelayedChain.length ? window.lastRelayedChain[window.lastRelayedChain.length-1].hash : null;
            collusionHeight = window.lastRelayedChain ? window.lastRelayedChain.length : 0;
            collusionTransactions = [{ id: 'ds-' + Date.now(), from: userId, to: t2, amount: amt, timestamp: Date.now() }];
            isColluding = true;
            $('#collusionBanner').remove();
            $('#miningActivity').prepend('<div class="alert alert-danger" id="collusionBanner"><strong>🚨 DOUBLE SPEND FORK ACTIVE</strong><br>Mining secret chain to rewrite history!</div>');
            if (isMining) stopMining();
            setTimeout(startMining, 500);
          };
          eval($('#validatorCodeEditor').val());
          showToastNotification('Double spend attack initiated!', 'warning');
        } catch(e) {
          showToastNotification('Script error: ' + e.message, 'error');
        }
      });
    }
    $('#executeDoubleSpendBtn').show();
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
  
  // Hard fork voting handlers
  $('#btnRejectFork').click(function() {
    myForkChoice = 'classic';
    if (net) net.send('hard-fork-vote', { choice: 'classic' });
    $('#forkChoiceModal').modal('hide');
    showToastNotification('You chose the Classic Chain.', 'info');
  });

  $('#btnAcceptFork').click(function() {
    myForkChoice = 'new';
    if (net) net.send('hard-fork-vote', { choice: 'new' });
    $('#forkChoiceModal').modal('hide');
    showToastNotification('You chose the New Chain.', 'warning');
  });

  // Fork toggling handlers
  $('#forkControlPanel').on('click', '#btnFollowClassic', function() {
    myForkChoice = 'classic';
    if (net) net.send('hard-fork-vote', { choice: 'classic' });
    showToastNotification('Switched to Classic Chain.', 'info');
    loadBlockchainState(); // Refresh view immediately
  });
  $('#forkControlPanel').on('click', '#btnFollowNew', function() {
    myForkChoice = 'new';
    if (net) net.send('hard-fork-vote', { choice: 'new' });
    showToastNotification('Switched to New Chain.', 'warning');
    loadBlockchainState(); // Refresh view immediately
  });
}

function startMining() {
  if (isMining) return;
  
  isMining = true;
  $('#mineBtn').hide();
  $('#stopMineBtn').show();
  
  fetchDataAndMine();
}

function seedLocalGenesisChain() {
  if (window.lastRelayedChain && window.lastRelayedChain.length > 0) return;
  const genesis = {
    index: 0,
    hash: '0000000000000000000000000000000000000000000000000000000000000000',
    previousHash: '0',
    timestamp: Date.now() - 10000,
    nonce: 0,
    transactions: [],
    miner: 'genesis',
    data: 'Genesis Block - Blockchain Lab (Client Relay)'
  };
  window.lastRelayedChain = [genesis];
  seenBlocks.add(genesis.hash);
  lastKnownAdminSettings = normalizeAdminSettings({
    difficultyLeading: 3,
    difficultySecondary: 15,
    miningRewardCoins: 10
  });
  $('#difficultyLevel').text('3 + 0xF');
  $('#blockchainView').append(
    '<div class="alert alert-warning">Local genesis ready. Start mining — blocks will sync when the instructor hub connects.</div>'
  );
}

function normalizeAdminSettings(settings) {
  const s = Object.assign({}, settings || {});
  const leading = parseInt(s.difficultyLeading, 10);
  const secondary = s.difficultySecondary !== undefined ? parseInt(s.difficultySecondary, 10) : 15;
  s.difficultyLeading = isNaN(leading) ? 3 : leading;
  s.difficultySecondary = isNaN(secondary) ? 15 : secondary;
  if (!s.currentDifficulty || typeof s.currentDifficulty !== 'object') {
    s.currentDifficulty = {
      leadingZeros: s.difficultyLeading,
      secondaryHex: Number(s.difficultySecondary).toString(16).toUpperCase()
    };
  } else {
    s.currentDifficulty.leadingZeros = s.currentDifficulty.leadingZeros || s.difficultyLeading;
    if (s.currentDifficulty.secondaryHex === undefined) {
      s.currentDifficulty.secondaryHex = Number(s.difficultySecondary).toString(16).toUpperCase();
    }
  }
  return s;
}

function getMiningDifficulty() {
  if (lastKnownAdminSettings && lastKnownAdminSettings.currentDifficulty &&
      typeof lastKnownAdminSettings.currentDifficulty === 'object') {
    return lastKnownAdminSettings.currentDifficulty;
  }
  return normalizeAdminSettings(lastKnownAdminSettings || {}).currentDifficulty;
}

function fetchDataAndMine() {
  if (!isMining) return;
  
  // If we are colluding, we mine on our secret fork instead of the main tip
  if (isColluding && collusionTipHash) {
    const newBlock = {
      index: collusionHeight,
      timestamp: Date.now(),
      nonce: 0,
      previousHash: collusionTipHash,
      transactions: collusionTransactions,
      miner: userId,
      difficulty: getMiningDifficulty(),
      hash: '',
      forkId: myForkChoice
    };
    mineBlock(newBlock, lastKnownAdminSettings);
    return;
  }

  // In client-relay, use the chain relayed from the admin hub
  if (window.lastRelayedChain && window.lastRelayedChain.length > 0) {
    const tipBlock = window.lastRelayedChain[window.lastRelayedChain.length - 1];
    const newBlock = {
      index: tipBlock.index + 1,
      timestamp: Date.now(),
      nonce: 0,
      previousHash: tipBlock.hash,
      transactions: [], // pending txs come via relay updates
      miner: userId,
      difficulty: getMiningDifficulty(),
      hash: '',
      forkId: myForkChoice
    };
    mineBlock(newBlock, lastKnownAdminSettings);
  } else {
    // No state yet — seed genesis once, then mine
    seedLocalGenesisChain();
    setTimeout(fetchDataAndMine, 200);
  }
}

function mineBlock(block, adminSettings) {
  const startTime = Date.now();
  let nonce = 0;
  let totalIterations = 0;
  let lastHashrateEmit = Date.now();
  
  // Report to network which block we're mining on (via relay if possible)
  if (net) {
    net.send('mining-on-block', {
      blockHash: block.previousHash,
      minerAddress: userId
    });
  } else if (socket) {
    socket.emit('mining-on-block', {
      sessionId: sessionId,
      blockHash: block.previousHash,
      minerAddress: userId
    });
  }
  
  $('#miningActivity').html(`
    <div class="alert alert-info">
      <p><strong>Mining in progress...</strong></p>
      <p>Nonce attempts: <span id="nonceCount">0</span></p>
      <p>Current hashrate: <span id="currentHashrate">0</span> H/s</p>
      <div class="progress" style="margin-top: 10px;">
        <div id="miningProgress" class="progress-bar progress-bar-striped active" style="width: 100%"></div>
      </div>
    </div>
  `);
  
  // Terminate existing worker if any
  if (miningWorker) {
    miningWorker.postMessage({ command: 'stop' });
    miningWorker.terminate();
  }

  // Create a Web Worker to act as an unthrottled background timer
  // This prevents the browser from stopping the miner when you switch tabs
  const workerCode = `
    let delay = 1;
    let timer = null;
    self.onmessage = function(e) {
      if (e.data.command === 'start') {
        delay = e.data.delay || 1;
        self.postMessage('tick');
      } else if (e.data.command === 'next') {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => self.postMessage('tick'), delay);
      } else if (e.data.command === 'stop') {
        if (timer) clearInterval(timer);
      }
    };
  `;
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  miningWorker = new Worker(URL.createObjectURL(blob));

  miningWorker.onmessage = function() {
    if (!isMining) {
      miningWorker.postMessage({ command: 'stop' });
      return;
    }
    
    // Mine in batches (every iteration tries 1000 nonces)
    const batchSize = 1000;
    for (let i = 0; i < batchSize; i++) {
      // Create block copy with fields for hashing, canonicalized (sorted keys)
      const blockObj = {
        index: block.index,
        timestamp: block.timestamp,
        nonce: nonce,
        previousHash: block.previousHash,
        transactions: block.transactions,
        miner: block.miner,
        difficulty: block.difficulty,
        forkId: block.forkId
      };
      
      // Canonicalize and stringify for consistent hashing
      const canonical = canonicalizeObject(blockObj);
      const blockCopy = JSON.stringify(canonical);
      
      const hash = sha256(blockCopy);
      
      // Check difficulty
      if (isValidHash(hash, block.difficulty)) {
        // Found valid hash!
        block.hash = hash;
        block.nonce = nonce;
        
        if (isColluding) {
          collusionTipHash = hash;
          collusionHeight++;
          collusionTransactions = []; // Clear secret transactions after they are included in our fork
        }
        
        // Create a copy to submit
        const minedBlock = JSON.parse(JSON.stringify(block));
        seenBlocks.add(hash); // Add to our own cache
        submitMinedBlock(minedBlock, startTime, totalIterations);
        
        // Optimistically start mining the next block immediately!
        block.index = block.index + 1;
        block.previousHash = block.hash;
        block.nonce = 0;
        block.hash = '';
        block.transactions = []; // Empty transactions for now (avoids double spending already mined txs)
        block.timestamp = Date.now();
        block.forkId = myForkChoice;
        nonce = 0;
        
        // Reset UI for next block
        $('#miningActivity').html(`
          <div class="alert alert-info">
            <p><strong>Mining in progress (Block #${block.index})...</strong></p>
            <p>Nonce attempts: <span id="nonceCount">0</span></p>
            <p>Current hashrate: <span id="currentHashrate">0</span> H/s</p>
            <div class="progress" style="margin-top: 10px;">
              <div id="miningProgress" class="progress-bar progress-bar-striped active" style="width: 100%"></div>
            </div>
          </div>
        `);
        
        if (net) {
          net.send('mining-on-block', {
            blockHash: block.previousHash,
            minerAddress: userId
          });
        } else if (socket) {
          socket.emit('mining-on-block', {
            sessionId: sessionId,
            blockHash: block.previousHash,
            minerAddress: userId
          });
        }
        
        // Break out of the batch loop early so it triggers the next batch via worker message
        break;
      }
      
      nonce++;
      totalIterations++;
    }
    
    // Update hashrate display
    const elapsed = Math.max(0.1, (Date.now() - startTime) / 1000);
    const hashrate = Math.max(1, Math.floor(totalIterations / elapsed));
    $('#nonceCount').text(nonce.toLocaleString());
    $('#currentHashrate').text(hashrate.toLocaleString());
    $('#yourHashrate').text(hashrate.toLocaleString() + ' H/s');
    
    // Update mining stats via socket reliably every 2 seconds
    const now = Date.now();
    if ((now - lastHashrateEmit > 2000)) {
      lastHashrateEmit = now;
      if (net) {
        net.send('hashrate-update', {
          userId: userId,
          hashrate: hashrate
        });
      } else if (socket) {
        socket.emit('hashrate-update', {
          sessionId: sessionId,
          hashrate: hashrate
        });
      }
    }
    
    // Request next batch
    miningWorker.postMessage({ command: 'next' });
  };

  miningWorker.postMessage({ command: 'start', delay: getMineCpuDelay() });
}

function getMineCpuDelay() {
  // Map CPU percentage to delay
  // 100% = 0ms (max speed), 50% = 25ms delay, 10% = 225ms delay
  const delayMs = Math.max(0, (100 - cpuLimitPercent) * 2.5);
  return delayMs;
}

function submitMinedBlock(block, startTime, totalIterations) {
  const totalTime = Date.now() - startTime;
  const hashrate = Math.floor(totalIterations / (totalTime / 1000));
  
  // In pure client-relay mode, we bypass the old /lab/mine server POST
  // and directly submit to the admin hub via the relay.
  showToastNotification(`⏳ Block found! Broadcasting to peers via relay...`, 'info');
  
  if (net) {
    debugLog('Broadcasting mined block via client relay');
    // In Full P2P mode, gossip the block to peers; otherwise submit to admin hub
    if (networkMode === 'p2p' || lastKnownAdminSettings?.networkMode === 'p2p' || lastKnownAdminSettings?.networkMode === 'real-p2p') {
      net.send('block-gossip', { block, minerId: userId });
      // Also emit locally as accepted for immediate UI feedback
      try { handleGossipBlock(block, userId); } catch (e) {}
      if (!window.lastRelayedChain) window.lastRelayedChain = [];
      window.lastRelayedChain.push(block);
    } else {
      net.send('block-submitted', { block, minerId: userId });
    }
  } else {
    console.warn('No net available for block submit');
  }
  
  // Optimistically continue mining on the new tip we just found
  // (the admin will confirm via block-accepted and we may reorg if needed)
}

function stopMining() {
  isMining = false;
  window.lastMiningIntent = false;
  $('#mineBtn').show();
  $('#stopMineBtn').hide();
  $('#miningActivity').html('<p class="text-muted">Mining stopped</p>');
  $('#yourHashrate').text('0 H/s');
  
  if (miningWorker) {
    miningWorker.postMessage({ command: 'stop' });
    miningWorker.terminate();
    miningWorker = null;
  }
  
  // Notify the network that we have stopped mining
  if (net) {
    net.send('hashrate-update', {
      userId: userId,
      hashrate: 0
    });
  } else if (socket) {
    socket.emit('hashrate-update', {
      sessionId: sessionId,
      hashrate: 0
    });
  }
}

function sendTransaction(recipientAddress, amount) {
  if (net) {
    const tx = {
      from: userId,
      to: recipientAddress,
      amount: amount,
      timestamp: Date.now()
    };
    net.send('transaction-submitted', { transaction: tx });
    $('#transactionForm')[0].reset();
    showToastNotification(`✅ Transaction submitted via relay to ${recipientAddress.substring(0, 8)}... for ${amount} coins`, 'success');
  } else {
    showToastNotification('No relay connection for transaction', 'error');
  }
}

function loadValidatorCode() {
  var url = (window.LabPaths && LabPaths.assetUrl)
    ? LabPaths.assetUrl('/data/validator-code.json')
    : '/data/validator-code.json';
  // Prefer static asset; fall back to Express route for local npm start
  $.getJSON(url).done(function(data) {
    if (data && data.code) {
      originalValidatorCode = data.code;
      $('#validatorCodeEditor').val(data.code);
      applyCustomValidator(data.code);
    } else if (data && data.success && data.code) {
      originalValidatorCode = data.code;
      $('#validatorCodeEditor').val(data.code);
      applyCustomValidator(data.code);
    }
  }).fail(function() {
    $.get('/lab/validator-code', function(data) {
      if (data.success) {
        originalValidatorCode = data.code;
        $('#validatorCodeEditor').val(data.code);
        applyCustomValidator(data.code);
      } else {
        $('#validatorCodeEditor').val('// Error loading code: ' + data.error);
      }
    }).fail(function() {
      $('#validatorCodeEditor').val('// Failed to load validator code.');
    });
  });
}

function loadBlockchainState() {
  // Legacy server-based load removed for client-relay only mode.
  // Updates come via net messages and handleGossipBlock / populate calls.
  if (typeof debugLog === 'function') debugLog('loadBlockchainState no-op in client-relay');
}

function updateParticipantBlockchainView(chainData, participants) {
  const blocks = chainData.chain || [];
  const CD = window.ChainDisplay;
  const nameLookup = CD ? CD.buildParticipantNameLookup(participants || []) : {};
  const fmtAddr = (addr) => (CD ? CD.formatChainParticipantHtml(addr, nameLookup) : `<code>${addr || ''}</code>`);
  
  if (blocks.length > 0) {
    localChainTipHash = blocks[blocks.length - 1].hash;
  }
  
  let html = '<h4>Your Blockchain Copy (Height: ' + blocks.length + ')</h4>';
  
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const highlight = block.miner === userId ? 'panel-success' : 'panel-default';
    const minerId = block.miner != null ? block.miner : '';
    
    let txHtml = `${block.transactions ? block.transactions.length : 0}`;
    if (block.transactions && block.transactions.length > 0) {
      txHtml += ' <button class="btn btn-xs btn-default" onclick="toggleTransactions(\'personal_' + i + '\')">View Details</button>';
      const displayStyle = openTxPanels.has('personal_' + i) ? 'block' : 'none';
      txHtml += '<div id="txDetails_personal_' + i + '" style="display:' + displayStyle + '; margin-top: 10px;">';
      txHtml += '<table class="table table-condensed">';
      txHtml += '<thead><tr><th>From</th><th>To</th><th>Amount</th><th>Time</th></tr></thead><tbody>';
      
      for (const tx of block.transactions) {
        const timeStr = tx.timestamp ? new Date(tx.timestamp).toLocaleTimeString() : '-';
        txHtml += `<tr>`;
        txHtml += `<td>${fmtAddr(tx.from)}</td>`;
        txHtml += `<td>${fmtAddr(tx.to)}</td>`;
        txHtml += `<td>${tx.amount} coins</td>`;
        txHtml += `<td>${timeStr}</td>`;
        txHtml += `</tr>`;
      }
      
      txHtml += '</tbody></table></div>';
    }

      const forkBadge = (block.forkId && block.forkId !== 'classic') ? `<span class="label label-warning pull-right">${block.forkId.toUpperCase()}</span>` : '';
    html += `
      <div class="panel ${highlight}">
        <div class="panel-heading">
            <strong>Block #${block.index}</strong> ${forkBadge}
          <span class="pull-right text-muted small">${new Date(block.timestamp).toLocaleTimeString()}</span>
        </div>
        <div class="panel-body">
          <dl class="dl-horizontal">
            <dt>Hash</dt>
            <dd><code style="font-size: 10px; word-break: break-all;">${block.hash}</code></dd>
            <dt>Previous Hash</dt>
            <dd><code style="font-size: 10px; word-break: break-all;">${block.previousHash}</code></dd>
            <dt>Miner</dt>
            <dd>${fmtAddr(minerId)}</dd>
            <dt>Nonce</dt>
            <dd>${block.nonce}</dd>
            <dt>Transactions</dt>
            <dd>${txHtml}</dd>
          </dl>
        </div>
      </div>
    `;
  }
  
  $('#blockchainView').html(html || '<p class="text-muted">No blocks yet</p>');
}

function updateNetworkBlockchainView(mainChain, orphans, participants) {
  const allBlocks = [...mainChain];
  const mainHashes = new Set(mainChain.map(b => b.hash));
  if (orphans && orphans.length > 0) {
    allBlocks.push(...orphans);
  }
  
  if (allBlocks.length === 0) {
    $('#networkBlockchainView').html('<p class="text-muted">No blocks yet</p>');
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
        const txId = `network_tx_${block.hash}`;
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
  
  $('#networkBlockchainView').html(html);
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

// Legacy sync functions removed (no server in client-relay mode; chain sync handled via relayed state from admin)


function updateParticipantList(blockchain) {
  const participants = blockchain.participants || [];
  let html = '';
  
  participants.forEach(p => {
    const roleLabel = p.role === 'wallet' ? '<span class="label label-info">Wallet</span>' : '<span class="label label-success">Miner</span>';
    const nameHtml = p.name ? `<strong style="display: block; margin-top: 4px;">${p.name}</strong>` : '';
    html += `<li class="list-group-item">
      ${roleLabel}
      <button class="btn btn-xs btn-default pull-right copy-btn" data-clipboard-text="${p.address}" title="Copy Address" style="margin-top: -2px;"><i class="glyphicon glyphicon-copy"></i></button>
      ${nameHtml}
      <div style="margin-top: 4px;"><code style="font-size: 10px; word-break: break-all;">${p.address}</code></div>
      <span class="text-muted small" style="margin-top: 4px; display: inline-block;">${p.minedBlocks || 0} blocks, ${p.balance || 0} coins</span>
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
        <td>${tx.amount}</td>
        <td>${new Date(tx.timestamp).toLocaleTimeString()}</td>
      </tr>
    `;
  });
  
  if (transactions.length === 0) {
    html = '<tr><td colspan="4" class="text-center text-muted">No pending transactions</td></tr>';
  }
  
  $('#pendingTransactions').html(html);
}

function updateNetworkStats(blockchain) {
  const stats = blockchain.networkStats || {};
  $('#blockHeight').text(stats.blockHeight || 0);
  $('#participantCount').text(blockchain.participants ? blockchain.participants.length : 0);
  $('#totalHashrate').text((stats.totalHashrate || 0).toFixed(0) + ' H/s');
}

function updateDifficultyInfo(settings) {
  const zeros = (settings.difficultyLeading || 4);
  const secondary = (settings.difficultySecondary || 8).toString(16).toUpperCase();
  $('#difficultyLevel').text(zeros + '-bit (0x' + secondary + ')');
}

// Check if hash meets difficulty requirement
function isValidHash(hash, difficulty) {
  if (window.customValidator) {
    if (window.customValidator._broken) return false; // Force failure if they broke the code
    try {
      const result = window.customValidator.validateDifficulty(hash, difficulty);
      return result && result.valid === true;
    } catch (e) {
      return false; // Broken logic causes hashing to fail forever
    }
  }
  
  if (difficulty == null) return false;
  if (typeof difficulty === 'number') {
    difficulty = { leadingZeros: Math.max(1, Math.floor(difficulty)), secondaryHex: 'F' };
  }
  if (typeof difficulty !== 'object') return false;
  
  const zeros = difficulty.leadingZeros != null ? difficulty.leadingZeros : 3;
  for (let i = 0; i < zeros; i++) {
    if (hash[i] !== '0') return false;
  }
  
  // Check secondary difficulty constraint to match backend logic
  if (difficulty.secondaryHex != null && String(difficulty.secondaryHex) !== '') {
    const nextChar = hash.charAt(zeros);
    if (nextChar && nextChar.toLowerCase() > String(difficulty.secondaryHex).toLowerCase()) return false;
  }
  
  return true;
}

