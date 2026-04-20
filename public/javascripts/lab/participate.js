/**
 * Blockchain Lab Participant (Miner) Interface
 * Handle mining blocks and sending transactions
 */

let socket = null;
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
const DEBUG_MODE = localStorage.getItem('blockchainLabDebug') === 'true'; // Enable via console: localStorage.setItem('blockchainLabDebug', 'true')

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
  sessionId = window.location.pathname.split('/').pop();
  
  // Display session code
  const joinCode = localStorage.getItem('joinCode_' + sessionId);
  if (joinCode) {
    $('#sessionCode').text(joinCode);
    $('#sessionCode').after('<span style="display: block; margin-top: 10px; text-align: center;"><strong>Your Role: </strong><span class="label label-success" style="font-size: 1em;">Miner</span></span>');
  }
  
  // Get userId from localStorage (set by landing.js when joining)
  userId = localStorage.getItem('userId_' + sessionId);
  if (!userId) {
    // Fallback: generate new if not found (for direct navigation)
    userId = 'user_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('userId_' + sessionId, userId);
  }
  
  // Initialize Socket.io
  initSocket();
  
  // Load initial state
  loadBlockchainState();
  loadValidatorCode();
  
  // Set up event handlers
  setupEventHandlers();
  
  // Note: Auto-refresh now happens via WebSocket block-broadcast events only
  // This eliminates constant polling and reduces server load
  
  
  // Initialize CPU usage display to match default
  $('#cpuUsage').val(cpuLimitPercent);
  $('#cpuUsageValue').text(cpuLimitPercent);

  // Display user info
  $('#yourAddress').text(userId);

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
});

function initSocket() {
  socket = io();
  
  socket.on('connect', function() {
    debugLog('Connected to server');
    socket.emit('miner-join', { 
      sessionId: sessionId,
      userId: userId
    });
  });
  
  // ============ TRUE P2P WEBRTC SIGNALING ============
  socket.on('webrtc-peers', (peers) => {
    peers.forEach(peerId => createWebRTCOffer(peerId));
  });
  
  socket.on('webrtc-offer', async (data) => {
    const pc = createPeerConnection(data.from);
    await pc.setRemoteDescription(data.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { target: data.from, answer: answer });
  });
  
  socket.on('webrtc-answer', async (data) => {
    const pc = rtcPeerConnections[data.from];
    if (pc) await pc.setRemoteDescription(data.answer);
  });
  
  socket.on('webrtc-ice', async (data) => {
    const pc = rtcPeerConnections[data.from];
    if (pc) await pc.addIceCandidate(data.candidate);
  });

  // ============ PROOF-OF-WORK HANDLERS (Local Validation) ============
  
  // Receive a block broadcast from the network
  socket.on('peer-block-received', function(data) {
    const { block, minerId } = data;
    
    handleGossipBlock(block, minerId);
  });
  
  function handleGossipBlock(block, minerId) {
    if (minerId === userId) return; // Ignore our own block
    if (seenBlocks.has(block.hash)) return; // Deduplicate! Stop infinite gossip loop
    
    seenBlocks.add(block.hash);
    debugLog(`Received gossip block from ${minerId}: ${block.hash.substring(0, 16)}... Evaluating.`);

    // Run custom validator if available
    if (window.customValidator) {
      if (window.customValidator._broken) {
        showToastNotification(`❌ Your broken validator rejected block #${block.index}`, 'error');
        return; // Node isolates itself if validator is broken
      }
      try {
        // Validate the hash matches the data
        const hashCheck = window.customValidator.validateBlockHash(block);
        if (!hashCheck) {
          showToastNotification(`❌ Validator rejected block hash!`, 'error');
          return;
        }
        // Validate difficulty
        const diffCheck = window.customValidator.validateDifficulty(block.hash, block.difficulty);
        if (diffCheck && diffCheck.valid === false) {
          showToastNotification(`❌ Validator rejected block: ${diffCheck.reason}`, 'error');
          return;
        }
        // Validate all transactions inside the block
        if (block.transactions) {
          for (const tx of block.transactions) {
            const txCheck = window.customValidator.validateTransaction(tx, block.transactions);
            if (txCheck && txCheck.valid === false) {
              showToastNotification(`❌ Validator rejected transaction: ${txCheck.reason}`, 'error');
              return;
            }
          }
        }
      } catch (e) {
        showToastNotification(`❌ Validator crashed during peer validation!`, 'error');
        return;
      }
    }

    // If we are on the collusion team and a fellow attacker found a block extending our secret chain
    if (isColluding && block.previousHash === collusionTipHash) {
      collusionTipHash = block.hash;
      collusionHeight = block.index + 1;
      if (isMining) {
        stopMining();
        setTimeout(startMining, 100);
      }
    }

    // Tell server to process this block for our local chain
    socket.emit('process-peer-block', { sessionId, block, minerId });
    
    // GOSSIP FORWARD: Send to our peers!
    if (lastKnownAdminSettings?.networkMode === 'real-p2p') {
      broadcastViaWebRTC(block, minerId);
    } else {
      socket.emit('gossip-forward', { sessionId, block, minerId });
    }
  }

  socket.on('chain-updated', function(data) {
    const { block, reason, minerId } = data;
    debugLog(`Chain updated! New tip: ${block.hash.substring(0, 16)}...`);
    
    // If we just mined this block, we are already optimistically mining the next one.
    if (minerId === userId && reason === 'mined') {
      loadBlockchainState();
      showToastNotification(`✅ Your block #${block.index} was added to your chain!`, 'success');
      return;
    }
    
    const wasMining = isMining || window.lastMiningIntent;
    if (isMining) stopMining(); // Stop mining on old tip
    
    // If the new block's parent isn't our old tip, it was a reorg
    const isReorg = localChainTipHash && block.previousHash !== localChainTipHash;
    
    // Reload UI
    loadBlockchainState();

    if (reason === 'peer-accepted') {
      if (isReorg) {
        showToastNotification(`🔄 Chain Reorg: Switched to longer chain! Block #${block.index} from ${minerId.substring(0, 8)}... is the new tip.`, 'info');
      } else {
        showToastNotification(`✅ Appended: Block #${block.index} from ${minerId.substring(0, 8)}... added to your chain!`, 'success');
      }
    } else if (reason === 'fork-stored') {
      showToastNotification(`⚠️ Your block #${block.index} was stored as an alternate branch.`, 'warning');
    } else {
      showToastNotification(`✅ Your block #${block.index} was added to your chain!`, 'success');
    }

    if (wasMining) {
      setTimeout(() => startMining(), 100); // Resume mining on new tip
    }
  });
  
  socket.on('fork-stored', function(data) {
    const { block } = data;
    debugLog(`Stored competing fork block #${block.index} locally.`);
    // Reload to see the fork branch
    loadBlockchainState();
  });

  socket.on('block-acceptance-failed', function(data) {
    const { blockHash, error } = data;
    debugWarn(`Block REJECTED: ${blockHash.substring(0, 16)}... - ${error}`);
    showToastNotification(`❌ Block rejected: ${error}`, 'error');
    
    if (window.lastMiningIntent) {
      setTimeout(() => startMining(), 500);
    }
  });

  // Update UI when a node joins or leaves
  socket.on('node-joined', function(data) {
    debugLog(`Node joined: ${data.userId}`);
    loadBlockchainState();
  });

  socket.on('node-left', function(data) {
    debugLog(`Node left: ${data.userId}`);
    loadBlockchainState();
  });

  socket.on('validator-modified', function(data) {
    debugLog(`Validator modified alert: ${data.message}`);
    // Only show warning if SOMEONE ELSE modified their rules
    if (data.userId !== userId) {
      showToastNotification(`⚠️ Miner ${data.userId.substring(0, 8)} modified their validator code!`, 'info');
    }
  });

  socket.on('team-attack-started', function(data) {
    const { colluders, honest, forkBlock } = data;
    $('#collusionBanner').remove();
    
    if (colluders.includes(userId)) {
      isColluding = true;
      collusionTipHash = forkBlock.hash;
      collusionHeight = forkBlock.index + 1;
      collusionTransactions = []; // Empty unless they trigger a double spend manually
      
      showToastNotification('🚨 You are on the COLLUSION TEAM! Mining secret fork...', 'error');
      $('#miningActivity').prepend('<div class="alert alert-danger" id="collusionBanner"><strong>🚨 COLLUSION TEAM ACTIVE</strong><br>You are secretly mining from Block #' + forkBlock.index + ' to rewrite history!</div>');
      if (isMining) { stopMining(); setTimeout(startMining, 500); }
    } else if (honest.includes(userId)) {
      isColluding = false;
      collusionTipHash = null;
      showToastNotification('🛡️ You are on the HONEST TEAM! Defend the main chain!', 'success');
      $('#miningActivity').prepend('<div class="alert alert-success" id="collusionBanner"><strong>🛡️ HONEST TEAM ACTIVE</strong><br>Defend the network from attackers!</div>');
    }
  });
  
  // Admin-triggered simulation code (51% attack, double spend, etc.)
  socket.on('attack-coordinated', function(data) {
    const { simulationType, role, attackersTeam, applyAtBlock, modifiedCode, codeDiff, message } = data;
    
    if (role === 'attacker') {
      // This user is selected to attack
      pendingDemoCode = modifiedCode;
      demoCodeApplyAtBlock = applyAtBlock;
      
      showToastNotification(`🔴 ATTACK SELECTED: ${simulationType} applies at block ${applyAtBlock}`, 'error');
      $('#miningActivity').prepend(
        `<div class="alert alert-warning" id="attackBanner">
          <strong>⚡ ATTACK IN PROGRESS</strong><br>
          Simulation: ${simulationType}<br>
          Your validator code will change at block #${applyAtBlock}<br>
          <button class="btn btn-xs btn-info" onclick="viewAttackDiff()">View Code Changes</button>
        </div>`
      );
      
      // Store codeDiff for viewing
      window.lastAttackDiff = codeDiff;
      
    } else if (role === 'honest') {
      // This user is honest, others are attacking
      showToastNotification(`Watch out! Others are attempting ${simulationType.replace('-', ' ')} at block ${applyAtBlock}!`, 'info');
      $('#miningActivity').prepend(
        `<div class="alert alert-info" id="attackBanner">
          <strong>ℹ️ ATTACK DETECTED</strong><br>
          ${message}<br>
          Monitor for chain divergence at block #${applyAtBlock}
        </div>`
      );
    }
  });
  
  // Helper function to view attack code diff
  window.viewAttackDiff = function() {
    if (window.lastAttackDiff) {
      alert('Code Changes:\n\n' + window.lastAttackDiff);
    }
  };
  
  socket.on('hard-fork-proposed', function(data) {
    const { height, name } = data;
    pendingForkHeight = height;
    $('#forkProposalName').text(name);
    $('#forkProposalHeight').text(height);
    $('#forkChoiceModal').modal('show');
  });

  // ============ LEGACY HANDLERS (for backward compatibility) ============
  
  socket.on('blockMined', function(block) {
    debugLog('New block mined by someone:', block);
    loadBlockchainState();
    
    // Stop mining if a new block was added
    if (isMining) {
      stopMining();
    }
  });
  
  socket.on('transactionAdded', function(transaction) {
    debugLog('New transaction:', transaction);
  });
  
  socket.on('settingsUpdated', function(settings) {
    debugLog('Settings updated:', settings);
    
    const oldMode = lastKnownAdminSettings?.networkMode;
    lastKnownAdminSettings = settings;
    
    if (settings.networkMode === 'real-p2p' && oldMode !== 'real-p2p') {
      setupWebRTC();
    } else if (settings.networkMode !== 'real-p2p' && oldMode === 'real-p2p') {
      teardownWebRTC();
    }
  });
  
  socket.on('error', function(error) {
    console.error('Socket error:', error);
    showToastNotification(`Connection error: ${error}`, 'error');
    
    if (error === 'Session not found or expired') {
      if (isMining) stopMining();
    }
  });
}

// ============ WEBRTC ENGINE ============
function setupWebRTC() {
  teardownWebRTC();
  socket.emit('request-webrtc-peers', { sessionId });
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
    if (e.candidate) socket.emit('webrtc-ice', { target: peerId, candidate: e.candidate });
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
  socket.emit('webrtc-offer', { target: peerId, offer: offer });
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
    
    // Emit node name change to server
    socket.emit('node-name-changed', {
      sessionId: sessionId,
      userId: userId,
      name: nodeName
    });
    
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
    
    const recipientAddress = $('#recipientAddress').val();
    const amount = parseFloat($('#transactionAmount').val());
    
    if (!recipientAddress || !amount || amount <= 0) {
      showToastNotification('Please enter valid recipient and amount', 'error');
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
    
    submitValidatorCode(modifiedCode);
  });
  
  $('#resetValidatorCodeBtn').click(function() {
    if (confirm('Are you sure you want to reset to the original validation code?')) {
      $('#validatorCodeEditor').val(originalValidatorCode);
      applyCustomValidator(originalValidatorCode);
      submitValidatorCode(originalValidatorCode);
      $('#executeDoubleSpendBtn').hide();
      $('#submitValidatorCodeBtn').show();
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
            $.get('/lab/my-chain/' + sessionId + '/' + userId, function(chainData) {
              collusionTipHash = chainData.tip;
              collusionHeight = chainData.height;
              collusionTransactions = [{ id: 'ds-' + Date.now(), from: userId, to: t2, amount: amt, timestamp: Date.now() }];
              isColluding = true;
              $('#collusionBanner').remove();
              $('#miningActivity').prepend('<div class="alert alert-danger" id="collusionBanner"><strong>🚨 DOUBLE SPEND FORK ACTIVE</strong><br>Mining secret chain to rewrite history!</div>');
              if (isMining) stopMining();
              setTimeout(startMining, 500);
            });
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
    socket.emit('hard-fork-vote', { sessionId, choice: 'classic' });
    $('#forkChoiceModal').modal('hide');
    showToastNotification('You chose the Classic Chain.', 'info');
  });

  $('#btnAcceptFork').click(function() {
    myForkChoice = 'new';
    socket.emit('hard-fork-vote', { sessionId, choice: 'new' });
    $('#forkChoiceModal').modal('hide');
    showToastNotification('You chose the New Chain.', 'warning');
  });

  // Fork toggling handlers
  $('#forkControlPanel').on('click', '#btnFollowClassic', function() {
    myForkChoice = 'classic';
    socket.emit('hard-fork-vote', { sessionId, choice: 'classic' });
    showToastNotification('Switched to Classic Chain.', 'info');
    loadBlockchainState(); // Refresh view immediately
  });
  $('#forkControlPanel').on('click', '#btnFollowNew', function() {
    myForkChoice = 'new';
    socket.emit('hard-fork-vote', { sessionId, choice: 'new' });
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

function fetchDataAndMine() {
  if (!isMining) return;
  
  // If we are colluding, we mine on our secret fork instead of fetching the network tip
  if (isColluding && collusionTipHash) {
    const newBlock = {
      index: collusionHeight,
      timestamp: Date.now(),
      nonce: 0,
      previousHash: collusionTipHash,
      transactions: collusionTransactions, // Will be empty after first successful block
      miner: userId,
      difficulty: lastKnownAdminSettings?.currentDifficulty || { leadingZeros: 4, secondaryHex: '8' },
      hash: '',
      forkId: myForkChoice
    };
    mineBlock(newBlock, lastKnownAdminSettings);
    return;
  }

  // Mining strictly relies on personal chain copy (P2P validation mode)
  $.get('/lab/my-chain/' + sessionId + '/' + userId)
    .done(function(chainData) {
      if (!isMining) return;
      if (chainData.success) {
        $.get('/lab/session/' + sessionId)
          .done(function(data) {
            if (!isMining) return;
            if (data.success) {
              const transactions = data.blockchain.pendingTransactions || [];
              const newBlock = {
                index: chainData.height,
                timestamp: Date.now(),
                nonce: 0,
                previousHash: chainData.tip,
                transactions: transactions,
                miner: userId,
                difficulty: data.adminSettings.currentDifficulty || { leadingZeros: 4, secondaryHex: '8' },
                hash: '',
                forkId: myForkChoice
              };
              mineBlock(newBlock, data.adminSettings);
            } else {
              setTimeout(fetchDataAndMine, 2000);
            }
          })
          .fail(function(xhr) {
            if (xhr.status === 404) {
              showToastNotification('Session expired. Please return to the homepage.', 'error');
              stopMining();
              return;
            }
            setTimeout(fetchDataAndMine, 2000);
          });
      } else {
        setTimeout(fetchDataAndMine, 2000);
      }
    })
    .fail(function(xhr) {
      if (xhr.status === 404) {
        showToastNotification('Session expired. Please return to the homepage.', 'error');
        stopMining();
        return;
      }
      setTimeout(fetchDataAndMine, 2000);
    });
}

function mineBlock(block, adminSettings) {
  const startTime = Date.now();
  let nonce = 0;
  let totalIterations = 0;
  
  // Report to network which block we're mining on
  if (socket) {
    socket.emit('mining-on-block', {
      sessionId: sessionId,
      blockHash: block.previousHash, // The block we're mining on top of
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
        
        if (socket) {
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
    const elapsed = (Date.now() - startTime) / 1000;
    const hashrate = Math.floor(totalIterations / elapsed);
    $('#nonceCount').text(nonce.toLocaleString());
    $('#currentHashrate').text(hashrate.toLocaleString());
    $('#yourHashrate').text(hashrate.toLocaleString() + ' H/s');
    
    // Update mining stats via socket
    if (socket && nonce % 10000 === 0) {
      socket.emit('hashrate-update', {
        sessionId: sessionId,
        hashrate: hashrate
      });
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
  
  $.ajax({
    type: 'POST',
    url: '/lab/mine',
    contentType: 'application/json',
    data: JSON.stringify({
      sessionId: sessionId,
      block: block
    }),
    success: function(data) {
      if (data.success) {
        showToastNotification(`⏳ Block found! Broadcasting to peers...`, 'info');
        
        if (socket) {
          debugLog('Broadcasting block to network');
          socket.emit('block-found', { sessionId, block });
          
          if (lastKnownAdminSettings?.networkMode === 'real-p2p') {
            broadcastViaWebRTC(block, userId);
          }
        }
      } else {
        console.warn('Block submission rejected:', data.error);
        // Don't stop mining on validation errors, just retry with updated chain
        console.log('Retrying mining with updated chain state...');
        setTimeout(() => {
          if (isMining) {
            isMining = false;
            startMining();
          }
        }, 500);
      }
    },
    error: function(xhr, status, error) {
      console.warn('Block submission failed:', error);
      // Network error - don't stop mining, just retry
      setTimeout(() => {
        if (isMining) {
          console.log('Retrying mining after network error...');
          isMining = false;
          startMining();
        }
      }, 500);
    }
  });
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
  if (socket) {
    socket.emit('hashrate-update', {
      sessionId: sessionId,
      hashrate: 0
    });
  }
}

function sendTransaction(recipientAddress, amount) {
  $.ajax({
    type: 'POST',
    url: '/lab/transaction',
    contentType: 'application/json',
    data: JSON.stringify({
      sessionId: sessionId,
      fromUserId: userId,
      toUserId: recipientAddress,
      amount: amount
    }),
    success: function(data) {
      if (data.success) {
        $('#transactionForm')[0].reset();
        // Show toast notification instead of modal
        showToastNotification(`✅ Transaction sent to ${recipientAddress.substring(0, 8)}... for ${amount} coins`, 'success');
        
        // Note: Balance will be updated when transaction is confirmed in a block
        // via the block-broadcast socket event and loadBlockchainState()
        
        // Broadcast to network
        if (socket) {
          socket.emit('transaction-sent', { sessionId, transaction: data.transaction });
        }
      } else {
        showToastNotification(`❌ Error: ${data.error}`, 'error');
      }
    },
    error: function() {
      showToastNotification('Failed to send transaction', 'error');
    }
  });
}

function loadValidatorCode() {
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
}

function submitValidatorCode(code) {
  $.ajax({
    type: 'POST',
    url: '/lab/validator-code',
    contentType: 'application/json',
    data: JSON.stringify({
      sessionId: sessionId,
      userId: userId,
      modifiedCode: code
    }),
    success: function(data) {
      if (data.success) {
        showToastNotification(data.message, 'success');
      } else {
        showToastNotification('Error: ' + data.error, 'error');
      }
    },
    error: function() {
      showToastNotification('Failed to submit modified code', 'error');
    }
  });
}

function loadBlockchainState() {
  const cacheBuster = '?t=' + Date.now();
  // Check personal chain first
  $.get('/lab/my-chain/' + sessionId + '/' + userId + cacheBuster, function(myChainData) {
    if (myChainData.success) {
      updateParticipantBlockchainView(myChainData);
      
      // Then fetch and render shared network data
      $.get('/lab/session/' + sessionId + cacheBuster, function(networkData) {
        if (networkData.success) {
          lastKnownAdminSettings = networkData.adminSettings;
          updateNetworkStats(networkData.blockchain);
          updateDifficultyInfo(networkData.adminSettings);
          updateParticipantList(networkData.blockchain);
          updatePendingTransactions(networkData.blockchain);
          
          const participant = networkData.blockchain.participants.find(p => p.address === userId);
          if (participant) {
            $('#yourBalance').text(participant.balance || 0);
            $('#blocksMined').text(participant.minedBlocks || 0);
            if (!isMining) $('#yourHashrate').text((participant.hashrate || 0) + ' H/s');
          }
          
          // Initialize WebRTC if loaded settings require it and not already active
          if (networkData.adminSettings.networkMode === 'real-p2p' && Object.keys(rtcPeerConnections).length === 0) {
            setupWebRTC();
          }
          
          // Fetch forks for the shared network view
          $.get('/lab/forks/' + sessionId + cacheBuster, function(forkData) {
            const orphans = (forkData.success && forkData.forks) ? forkData.forks.orphans : [];
            updateNetworkBlockchainView(networkData.blockchain.chain, orphans);
          }).fail(function() {
            updateNetworkBlockchainView(networkData.blockchain.chain, []);
          });
          
          // Sync comparison logic
          const networkChainLength = networkData.blockchain.chain.length;
          const personalChainLength = myChainData.height || 0;
          
          if (networkChainLength > personalChainLength) {
            const diff = networkChainLength - personalChainLength;
            let syncBtn = $('#syncToLongerChainBtn');
            if (syncBtn.length === 0) {
              syncBtn = $('<button class="btn btn-sm btn-info" id="syncToLongerChainBtn" style="margin-left: 10px;"><i class="glyphicon glyphicon-refresh"></i> Sync to Longer Chain</button>');
              $('#blockchainView').before(syncBtn);
              syncBtn.on('click', function() {
                syncMinerToLongerChain(networkData.blockchain.chain);
              });
            }
            syncBtn.html('<i class="glyphicon glyphicon-refresh"></i> Sync Chain (+' + diff + ' blocks)').show();
          } else {
            $('#syncToLongerChainBtn').hide();
          }

          // Fork control logic
          const forkIsActive = pendingForkHeight && orphans.some(o => o.index >= pendingForkHeight);
          if (forkIsActive) {
            $('#forkControlPanel').show();
            if (myForkChoice === 'classic') {
              $('#btnFollowClassic').addClass('btn-primary').removeClass('btn-default');
              $('#btnFollowNew').addClass('btn-default').removeClass('btn-primary');
            } else {
              $('#btnFollowNew').addClass('btn-primary').removeClass('btn-default');
              $('#btnFollowClassic').addClass('btn-default').removeClass('btn-primary');
            }
          } else {
            $('#forkControlPanel').hide();
          }
        }
      });
    } else {
      if (myChainData.error === 'Session not found') {
        $('#blockchainView').html('<div class="alert alert-danger text-center">Session expired or not found. Please return to the homepage to join a new session.</div>');
        if (isMining) stopMining();
      }
    }
  }).fail(function(xhr) {
    if (xhr.status === 404) {
      $('#blockchainView').html('<div class="alert alert-danger text-center">Session expired or not found. Please return to the homepage to join a new session.</div>');
      if (isMining) stopMining();
    }
  });
}

function updateParticipantBlockchainView(chainData) {
  const blocks = chainData.chain || [];
  
  if (blocks.length > 0) {
    localChainTipHash = blocks[blocks.length - 1].hash;
  }
  
  let html = '<h4>Your Blockchain Copy (Height: ' + blocks.length + ')</h4>';
  
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    const highlight = block.miner === userId ? 'panel-success' : 'panel-default';
    
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
        txHtml += `<td><code style="font-size: 9px;">${(tx.from || 'unknown').substring(0, 8)}...</code></td>`;
        txHtml += `<td><code style="font-size: 9px;">${(tx.to || 'unknown').substring(0, 8)}...</code></td>`;
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
            <dd><code style="font-size: 11px;">${block.miner.substring(0, 12)}...</code></dd>
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

function updateNetworkBlockchainView(mainChain, orphans) {
  const allBlocks = [...mainChain];
  const mainHashes = new Set(mainChain.map(b => b.hash));
  if (orphans && orphans.length > 0) {
    allBlocks.push(...orphans);
  }
  
  if (allBlocks.length === 0) {
    $('#networkBlockchainView').html('<p class="text-muted">No blocks yet</p>');
    return;
  }

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

  for (let i = maxIndex; i >= 0; i--) {
    if (!byIndex[i]) continue;
    
    html += `<div style="display: flex; justify-content: center; flex-wrap: wrap; gap: 15px; margin-bottom: 5px;">`;
    
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
          txHtml += `<tr><td><code style="font-size: 9px;">${(tx.from||'').substring(0,8)}...</code></td><td><code style="font-size: 9px;">${(tx.to||'').substring(0,8)}...</code></td><td>${tx.amount}</td></tr>`;
        }
        txHtml += `</tbody></table></div>`;
      }

      const forkBadge = (block.forkId && block.forkId !== 'classic') ? `<span class="label label-info pull-right" style="margin-right: 5px;">${block.forkId.toUpperCase()}</span>` : '';
      html += `
      <div class="panel ${panelClass}" style="flex: 0 1 340px; margin-bottom: 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
        <div class="panel-heading" style="padding: 8px 15px;">
          <strong>Block #${block.index}</strong> ${label} ${forkBadge}
          <div class="pull-right text-muted small" style="margin-top: 2px;">${new Date(block.timestamp).toLocaleTimeString()}</div>
        </div>
        <div class="panel-body" style="padding: 10px 15px;">
          <dl class="dl-horizontal" style="margin-bottom: 0;">
            <dt style="width: 80px;">Hash</dt><dd style="margin-left: 90px;"><code style="font-size: 10px; word-break: break-all;">${block.hash.substring(0, 16)}...</code></dd>
            <dt style="width: 80px;">Prev Hash</dt><dd style="margin-left: 90px;"><code style="font-size: 10px; word-break: break-all;">${block.previousHash.substring(0, 16)}...</code></dd>
            <dt style="width: 80px;">Miner</dt><dd style="margin-left: 90px;"><code style="font-size: 11px;">${block.miner.substring(0, 12)}...</code></dd>
            <dt style="width: 80px;">Nonce</dt><dd style="margin-left: 90px;">${block.nonce}</dd>
            <dt style="width: 80px;">Txs</dt><dd style="margin-left: 90px;">${txHtml}</dd>
          </dl>
        </div>
      </div>
      `;
    }
    html += `</div>`;
    
    if (i > 0) {
      let hasFork = false;
      if (byIndex[i]) {
        for (const block of byIndex[i]) {
          if (!mainHashes.has(block.hash)) {
            hasFork = true;
            break;
          }
        }
      }
      const arrowColor = hasFork ? '#f0ad4e' : '#bbb';
      if (hasFork) {
        html += `<div style="text-align: center; margin-bottom: 5px; color: ${arrowColor};">
                   <i class="glyphicon glyphicon-arrow-down" style="display: inline-block; transform: translateX(-10px) rotate(15deg);"></i>
                   <i class="glyphicon glyphicon-arrow-down" style="display: inline-block; transform: translateX(10px) rotate(-15deg);"></i>
                 </div>`;
      } else {
        html += `<div style="text-align: center; margin-bottom: 5px; color: ${arrowColor};"><i class="glyphicon glyphicon-arrow-down"></i></div>`;
      }
    }
  }
  html += '</div>';
  
  const oldScrollTop = $(window).scrollTop();
  const oldDocHeight = $(document).height();
  
  $('#networkBlockchainView').html(html);
  
  if (oldScrollTop > 50) {
    const heightDiff = $(document).height() - oldDocHeight;
    if (heightDiff !== 0) {
      $(window).scrollTop(oldScrollTop + heightDiff);
    }
  }
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

function syncMinerToLongerChain(newChain) {
  if (!newChain || newChain.length === 0) {
    console.warn('No valid chain to sync to');
    return;
  }
  
  $.ajax({
    url: '/lab/sync-chain',
    type: 'POST',
    contentType: 'application/json',
    data: JSON.stringify({
      sessionId: sessionId,
      userId: userId,
      targetChain: newChain
    }),
    success: function(response) {
      if (response.success) {
        console.log(`✅ Successfully synced to longer chain (height: ${response.newHeight})`);
        showToastNotification(`✅ Chain updated! Now mining on chain with ${response.newHeight} blocks.`, 'success');
        loadBlockchainState();
      } else {
        console.warn('Sync failed:', response.error);
        showToastNotification('Could not sync to new chain. Continue with current chain.', 'error');
      }
    },
    error: function(err) {
      console.error('Sync error:', err);
      showToastNotification('Error syncing to longer chain. Continue with current chain.', 'error');
    }
  });
}

function updatePersonalChainToNetwork(networkBlockchain) {
  // This function updates the personal chain to match the network blockchain
  // It's called when the network chain has more work
  $.ajax({
    type: 'POST',
    url: '/lab/sync-chain',
    contentType: 'application/json',
    data: JSON.stringify({
      sessionId: sessionId,
      userId: userId,
      targetChain: networkBlockchain.chain
    }),
    success: function(data) {
      if (data.success) {
        console.log('Personal chain updated to match network chain');
      }
    },
    error: function(error) {
      console.warn('Could not sync personal chain:', error);
    }
  });
}

function updateParticipantList(blockchain) {
  const participants = blockchain.participants || [];
  let html = '';
  
  participants.forEach(p => {
    const roleLabel = p.role === 'wallet' ? '<span class="label label-info">Wallet</span>' : '<span class="label label-success">Miner</span>';
    html += `<li class="list-group-item">
      ${roleLabel} <strong style="word-break: break-all;">${p.address}</strong>
      <button class="btn btn-xs btn-default pull-right copy-btn" data-clipboard-text="${p.address}" title="Copy Address"><i class="glyphicon glyphicon-copy"></i></button>
      <br><span class="text-muted small" style="margin-top: 4px; display: inline-block;">${p.minedBlocks || 0} blocks, ${p.balance || 0} coins</span>
    </li>`;
  });
  
  if (participants.length === 0) {
    html = '<li class="list-group-item text-muted"><em>Waiting for miners and wallets...</em></li>';
  }
  
  $('#participantList').html(html);
}

function updatePendingTransactions(blockchain) {
  const transactions = blockchain.pendingTransactions || [];
  let html = '';
  
  transactions.forEach(tx => {
    html += `
      <tr>
        <td><code style="font-size: 10px;">${tx.from.substring(0, 10)}...</code></td>
        <td><code style="font-size: 10px;">${tx.to.substring(0, 10)}...</code></td>
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
  
  if (!difficulty) return false;
  
  const zeros = difficulty.leadingZeros || 4;
  for (let i = 0; i < zeros; i++) {
    if (hash[i] !== '0') return false;
  }
  
  // Check secondary difficulty constraint to match backend logic
  if (difficulty.secondaryHex) {
    const nextChar = hash.charAt(zeros);
    if (nextChar.toLowerCase() > difficulty.secondaryHex.toLowerCase()) return false;
  }
  
  return true;
}
