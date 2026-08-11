/**
 * Blockchain Lab Observer View
 * Real-time view of the blockchain network
 */

let sessionId = null;
let userId = null;
let openTxPanels = new Set();

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
  sessionId = (window.LabPaths && LabPaths.getSessionIdFromLocation()) || window.location.pathname.split('/').pop();
  
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

  $('#setNodeNameBtn').on('click', function() {
    const nodeName = $('#nodeName').val().trim();
    if (nodeName.length > 50) {
      showToastNotification('Display name must be 50 characters or less', 'error');
      return;
    }
    if (!socket || !socket.connected) {
      showToastNotification('Not connected yet — try again in a moment', 'error');
      return;
    }
    socket.emit('node-name-changed', {
      sessionId: sessionId,
      userId: userId,
      name: nodeName
    });
    showToastNotification(nodeName ? 'Display name saved!' : 'Display name cleared', 'success');
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
    if (state.block && !state.chain) {
      // Single block acceptance — append visually if we have a tip
      if (!window._observerChain) window._observerChain = [];
      window._observerChain.push(state.block);
      populateObserverUIFromState({ chain: window._observerChain, participants: state.participants || [] });
    } else {
      populateObserverUIFromState(state);
    }
  });

  net.on('block-gossip', (msg) => {
    const block = (msg.payload && msg.payload.block) || msg.block;
    if (!block) return;
    if (!window._observerChain) window._observerChain = [];
    window._observerChain.push(block);
    populateObserverUIFromState({ chain: window._observerChain.slice() });
  });

  net.on('initial-state', (msg) => {
    const state = msg.payload || msg;
    if (state.chain) window._observerChain = state.chain.slice();
    debugLog('Received initial state from admin relay for observer', state);
    populateObserverUIFromState(state);
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

function populateObserverUIFromState(state) {
  if (!state) return;
  try {
    const chain = state.chain || [];
    const participants = state.participants || [];
    const orphans = []; // no forks info for now

    if (state.adminSettings && typeof updateAdminSettings === 'function') {
      updateAdminSettings(state.adminSettings);
    }

    if (typeof updateNetworkStats === 'function') {
      updateNetworkStats({ networkStats: state.networkStats || {}, participants: participants });
    }

    if (typeof updateParticipantList === 'function') {
      updateParticipantList({ participants: participants });
    }

    if (typeof updatePendingTransactions === 'function') {
      updatePendingTransactions({ pendingTransactions: state.pendingTransactions || [], participants: participants });
    }

    if (typeof updateBlockchainView === 'function') {
      updateBlockchainView(chain, orphans, participants);
    }

    if (state.chain && state.chain.length > 0) {
      const tip = state.chain[state.chain.length-1];
      // optional: update your balance if observer has one, but for wallet it might
      if (userId) {
        const me = participants.find(p => p.address === userId);
        if (me && me.balance !== undefined) {
          $('#yourBalance').text(me.balance);
        }
        const $nodeName = $('#nodeName');
        if ($nodeName.length && !$nodeName.is(':focus') && me && me.name) {
          $nodeName.val(me.name);
        }
      }
    }
  } catch (e) {
    console.error('Error populating observer UI from relay state', e);
  }
}

function loadBlockchainState() {
  // no-op in client-relay mode; population handled via net messages in populateObserverUIFromState
  debugLog && debugLog('loadBlockchainState no-op for observer in relay mode');
}

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

  // Add a nice background to the view container to frame the tree
  $('#blockchainView').css('background-color', '#fcfcfc').css('padding', '15px').css('border-radius', '4px');

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
    $('#lastBlockTime').text(secondsAgo + 's ago');
  }
}

function updateParticipantList(blockchain) {
  const participants = blockchain.participants || [];
  let html = '';
  
  participants.forEach(p => {
    const roleLabel = p.role === 'wallet' ? '<span class="label label-info">Wallet</span>' : '<span class="label label-success">Miner</span>';
    const nameHtml = p.name ? `<strong style="display: block; margin-top: 4px;">${p.name}</strong>` : '';
    html += `<li style="margin-bottom: 8px; border-bottom: 1px solid #eee; padding-bottom: 8px;">
      ${roleLabel} 
      <button class="btn btn-xs btn-default pull-right copy-btn" data-clipboard-text="${p.address}" title="Copy Address"><i class="glyphicon glyphicon-copy"></i></button>
      ${nameHtml}
      <div style="margin-top: 4px;"><code style="font-size: 10px; word-break: break-all;">${p.address}</code></div>
      <br><span class="text-muted small" style="margin-top: 4px; display: inline-block;">${p.minedBlocks || 0} blocks, ${p.balance || 0} coins</span>
    </li>`;
  });
  
  if (participants.length === 0) {
    html = '<li><em class="text-muted">Waiting for miners and wallets...</em></li>';
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
