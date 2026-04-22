/**
 * Blockchain Lab Observer View
 * Real-time view of the blockchain network
 */

let socket = null;
let sessionId = null;
let userId = null;
let openTxPanels = new Set();

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
  
  // Get userId from localStorage (set by landing.js when joining)
  userId = localStorage.getItem('userId_' + sessionId);
  if (!userId) {
    // Fallback: generate new if not found (for direct navigation)
    userId = 'user_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('userId_' + sessionId, userId);
  }
  
  // Display user address
  $('#yourAddress').text(userId);
  
  // Display session code
  const joinCode = localStorage.getItem('joinCode_' + sessionId);
  if (joinCode) {
    $('#sessionCode').text(joinCode);
    $('#sessionCode').after('<span style="display: block; margin-top: 10px; text-align: center;"><strong>Your Role: </strong><span class="label label-info" style="font-size: 1em;">Wallet</span></span>');
  }
  
  // Initialize Socket.io
  initSocket();
  
  // Load initial state
  loadBlockchainState();
  
  // Set up event handlers
  setupEventHandlers();
  
  // Auto-refresh blockchain state
  setInterval(loadBlockchainState, 2000);
  
  // Mobile optimization: Refresh immediately when tab becomes visible again
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
      loadBlockchainState();
    }
  });
});

function setupEventHandlers() {
  // Handle transaction form
  $('#transactionForm').on('submit', function(e) {
    e.preventDefault();
    
    const toUserId = $('#recipientAddress').val().trim();
    const amount = parseFloat($('#transactionAmount').val());
    
    if (!toUserId || !amount || amount <= 0) {
      showToastNotification('Please fill in all fields with valid values', 'error');
      return;
    }
    
    $.ajax({
      type: 'POST',
      url: '/lab/transaction',
      contentType: 'application/json',
      data: JSON.stringify({
        sessionId: sessionId,
        fromUserId: userId,
        toUserId: toUserId,
        amount: amount
      }),
      success: function(data) {
        if (data.success) {
          showToastNotification('Transaction sent successfully!', 'success');
          $('#recipientAddress').val('');
          $('#transactionAmount').val('');
          
          // Retrieve and update balance from server (wait for block to be mined)
          loadBlockchainState();
          
          if (socket) {
            socket.emit('transaction-sent', { sessionId: sessionId, transaction: data.transaction });
          }
        } else {
          showToastNotification(`Error: ${data.error || 'Unknown error occurred'}`, 'error');
        }
      },
      error: function(xhr, status, error) {
        console.error('Transaction error:', error);
        showToastNotification(`Failed to send transaction: ${error}`, 'error');
      }
    });
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
}

function initSocket() {
  socket = io();
  
  socket.on('connect', function() {
    console.log('Connected to server');
    socket.emit('wallet-join', { sessionId: sessionId, userId: userId });
  });

  // ============ PROOF-OF-WORK EVENTS (Blockchain Broadcasting) ============
  
  socket.on('block-broadcast', function(data) {
    const { block, minerId, broadcastedAt } = data;
    console.log(`[BLOCK] Broadcast from ${minerId}: ${block.hash.substring(0, 16)}... (index: ${block.index})`);
    loadBlockchainState();
  });

  socket.on('block-accepted', function(data) {
    const { block } = data;
    console.log(`[BLOCK] Added to chain: ${block.hash.substring(0, 16)}...`);
    loadBlockchainState();
  });

  // Track which miners are mining on which blocks
  socket.on('miner-status-update', function(data) {
    const { minerId, blockHash, timestamp } = data;
    console.log(`[MINING] ${minerId} is mining on ${blockHash}...`);
    // Update mining consensus view  
    updateMiningStatus();
  });

  // Update UI when a node joins or leaves
  socket.on('node-joined', function(data) {
    console.log(`Node joined: ${data.userId}`);
    loadBlockchainState();
  });

  socket.on('node-left', function(data) {
    console.log(`Node left: ${data.userId}`);
    loadBlockchainState();
  });

  // ============ LEGACY HANDLERS ============
  
  socket.on('blockMined', function(block) {
    console.log('New block mined:', block);
    loadBlockchainState();
  });
  
  socket.on('transactionAdded', function(transaction) {
    console.log('New transaction:', transaction);
    loadBlockchainState();
  });
  
  socket.on('settingsUpdated', function(settings) {
    console.log('Admin settings updated:', settings);
    updateAdminSettings(settings);
  });
  
  socket.on('error', function(error) {
    console.error('Socket error:', error);
  });
}

function loadBlockchainState() {
  const cacheBuster = '?t=' + Date.now();
  $.when(
    $.get('/lab/session/' + sessionId + cacheBuster),
    $.get('/lab/forks/' + sessionId + cacheBuster)
  ).done(function(sessionRes, forksRes) {
    const data = sessionRes[0];
    const forksData = forksRes[0];
    
    if (data.success) {
      updateNetworkStats(data.blockchain);
      updateParticipantList(data.blockchain);
      updatePendingTransactions(data.blockchain);
      updateAdminSettings(data.adminSettings);
      
      if (data.blockchain && data.blockchain.participants) {
        const observer = data.blockchain.participants.find(p => p.address === userId);
        if (observer && observer.balance !== undefined) {
          $('#yourBalance').text(observer.balance);
        }
      }
      
      const orphans = (forksData.success && forksData.forks) ? forksData.forks.orphans : [];
      updateBlockchainView(data.blockchain.chain, orphans);
    }
  }).fail(function(error) {
    console.error('Error loading blockchain state:', error);
  });
}

function updateBlockchainView(mainChain, orphans) {
  const allBlocks = [...mainChain];
  const mainHashes = new Set(mainChain.map(b => b.hash));
  if (orphans && orphans.length > 0) {
    allBlocks.push(...orphans);
  }
  
  if (allBlocks.length === 0) {
    $('#blockchainView').html('<p class="text-muted">No blocks yet</p>');
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

  // Add a nice background to the view container to frame the tree
  $('#blockchainView').css('background-color', '#fcfcfc').css('padding', '15px').css('border-radius', '4px');

  let html = '<div style="display: flex; flex-direction: column; width: 100%;">';

  for (let i = 0; i <= maxIndex; i++) {
    if (!byIndex[i]) continue;
    
    html += `<div style="display: flex; justify-content: center; flex-wrap: wrap; gap: 15px; margin-bottom: 5px;">`;
    
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
          txHtml += `<tr><td><code style="font-size: 9px;">${(tx.from||'').substring(0,8)}...</code></td><td><code style="font-size: 9px;">${(tx.to||'').substring(0,8)}...</code></td><td>${tx.amount}</td></tr>`;
        }
        txHtml += `</tbody></table></div>`;
      }

      const forkBadge = (block.forkId && block.forkId !== 'classic') ? `<span class="label label-info pull-right" style="margin-right: 5px;">${block.forkId.toUpperCase()}</span>` : '';
      html += `
      <div class="panel ${panelClass}" style="flex: 1 1 300px; max-width: 100%; margin-bottom: 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
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
    
    if (i < maxIndex) {
      let hasFork = false;
      if (byIndex[i+1]) {
        for (const block of byIndex[i+1]) {
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
    html += `<li style="margin-bottom: 8px; border-bottom: 1px solid #eee; padding-bottom: 8px;">
      ${roleLabel} <strong style="word-break: break-all;">${p.address}</strong>
      <button class="btn btn-xs btn-default pull-right copy-btn" data-clipboard-text="${p.address}" title="Copy Address"><i class="glyphicon glyphicon-copy"></i></button>
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
