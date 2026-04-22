/**
 * Blockchain Lab Admin Dashboard
 * Manage network settings and monitor blockchain
 */

let socket = null;
let sessionId = null;
let adminToken = null;
let initialSettingsLoaded = false;
let openTxPanels = new Set();
let networkViz = null; // Network visualization instance

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
  // Extract sessionId from URL
  sessionId = window.location.pathname.split('/').pop();
  
  // Get admin token from localStorage or create new one
  adminToken = localStorage.getItem('adminToken_' + sessionId);
  
  // Display session code and admin token
  const joinCode = localStorage.getItem('joinCode_' + sessionId);
  if (joinCode) {
    $('#sessionCode').text(joinCode);
    $('#sessionCode').after('<span style="display: block; margin-top: 10px; text-align: center;"><strong>Your Role: </strong><span class="label label-danger" style="font-size: 1em;">Admin</span></span>');
  }
  if (adminToken) {
    $('#adminTokenDisplay').text(adminToken);
  }
  
  // Initialize Socket.io
  initSocket();
  
  // Initialize Network Visualization
  networkViz = new NetworkVisualization('#networkVisualizationSvg');
  
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

function initSocket() {
  socket = io();
  
  socket.on('connect', function() {
    console.log('Connected to server');
    socket.emit('admin-join', { sessionId: sessionId });
  });
  
  socket.on('blockchainUpdated', function(data) {
    updateBlockchainView(data);
  });
  
  socket.on('blockMined', function(block) {
    console.log('New block mined:', block);
    loadBlockchainState();
    playBlockMinedAnimation();
  });
  
  socket.on('settingsUpdated', function(settings) {
    console.log('Settings updated:', settings);
    updateSettingsDisplay(settings);
  });
  
  socket.on('transactionAdded', function(transaction) {
    console.log('New transaction:', transaction);
    loadBlockchainState();
  });
  
  socket.on('error', function(error) {
    console.error('Socket error:', error);
  });
  
  socket.on('team-hashrate-update', function(data) {
    $('#honestHashrate').text(data.honestH);
    $('#collusionHashrate').text(data.colludeH);
  });
  
  // Network visualization events
  socket.on('peer-assignments-updated', function(data) {
    if (data.peerAssignments && networkViz) {
      const miners = data.peerAssignments.map(assignment => {
        const existing = nodeInfo.get(assignment.userId);
        let currentStatus = (existing && existing.status !== 'offline') ? existing.status : 'idle';
        if (assignment.hashrate > 0) currentStatus = 'mining';
        
        return {
          userId: assignment.userId,
          address: assignment.userId,
          name: assignment.name,
          status: currentStatus,
          chainHeight: existing?.chainHeight || 0,
          hashrate: assignment.hashrate || existing?.hashrate || 0,
          forkChoice: assignment.forkChoice,
          isColluding: assignment.isColluding
        };
      });
      
      // Update node info map
      miners.forEach(miner => {
        nodeInfo.set(miner.userId, {
          name: miner.name,
          status: miner.status,
          forkChoice: miner.forkChoice,
          isColluding: miner.isColluding
        });
      });
      
      const peerMap = new Map();
      data.peerAssignments.forEach(({ userId, peers }) => {
        peerMap.set(userId, peers);
      });
      
      networkViz.updateTopology(miners, peerMap);
      updateNodeNamesList();
    }
  });
  
  socket.on('block-found-visualization', function(data) {
    if (networkViz) {
      const { blockHash, minerId, blockHeight, peerList } = data;
      
      // Animate block mining
      networkViz.animateBlockMined(minerId);
      
      // Animate block propagation to peers
      if (peerList && peerList.length > 0) {
        networkViz.animateBlockPropagation(minerId, peerList, { hash: blockHash, index: blockHeight });
      }
    }
  });
  
  socket.on('node-offline', function(data) {
    if (networkViz && data.userId) {
      const status = 'offline';
      networkViz.setNodeStatus(data.userId, status);
      if (nodeInfo.has(data.userId)) nodeInfo.get(data.userId).status = status;
    }
  });
  
  socket.on('node-left', function(data) {
    if (networkViz && data.userId) {
      const status = 'offline';
      networkViz.setNodeStatus(data.userId, status);
      if (nodeInfo.has(data.userId)) nodeInfo.get(data.userId).status = status;
    }
  });
  
  socket.on('node-name-changed', function(data) {
    if (networkViz && data.userId && data.name) {
      networkViz.setNodeName(data.userId, data.name);
      
      // Update nodeInfo map
      if (nodeInfo.has(data.userId)) {
        nodeInfo.get(data.userId).name = data.name;
      } else {
        nodeInfo.set(data.userId, { name: data.name, status: 'idle' });
      }
      
      updateNodeNamesList();
    }
  });
  
  // Request initial network state
  socket.on('initial-state', function(data) {
    // Try to initialize network on first state
    if (networkViz && !networkViz.hasInitialized) {
      loadBlockchainState(); // Will load participants and call initializeNetwork
    }
  });

  socket.on('hashrate-updated', function(data) {
    if (networkViz && data.userId) {
      const status = data.hashrate > 0 ? 'mining' : 'idle';
      networkViz.setNodeStatus(data.userId, status);
      if (nodeInfo.has(data.userId)) {
        nodeInfo.get(data.userId).status = status;
        nodeInfo.get(data.userId).hashrate = data.hashrate;
      }
    }
  });

  socket.on('miner-status-update', function(data) {
    if (networkViz && data.minerId) {
      networkViz.setNodeStatus(data.minerId, 'mining');
      if (nodeInfo.has(data.minerId)) nodeInfo.get(data.minerId).status = 'mining';
    }
  });
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
    const newSettings = {
      difficultyLeading: parseInt($('#difficultyLeading').val()),
      difficultySecondary: parseInt($('#difficultySecondary').val()),
      miningRewardCoins: parseInt($('#miningReward').val()),
      networkMode: $('#networkModeSelect').val(),
      parametersLocked: $('#lockParameters').is(':checked')
    };
    
    $.ajax({
      type: 'POST',
      url: '/lab/updateSettings',
      contentType: 'application/json',
      data: JSON.stringify({
        adminToken: adminToken,
        newSettings: newSettings
      }),
      success: function(data) {
        if (data.success) {
          showToastNotification('Settings updated successfully!', 'success');
          // Broadcast to all connected clients
          if (socket) {
            socket.emit('settings-changed', { sessionId, settings: data.settings });
          }
        } else {
          showToastNotification(`Error: ${data.error}`, 'error');
        }
      }
    });
  });
  
  // Network toggle
  $('#toggleNetworkBtn').click(function() {
    const isPaused = $(this).data('paused') || false;
    const willPause = !isPaused;
    $(this).text(willPause ? 'Resume Network' : 'Pause Network');
    $(this).data('paused', willPause);
    socket.emit('toggle-network', { sessionId, paused: willPause });
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
    <p class="small text-muted">Automatically assigns ~50% of miners to a collusion team to attempt a chain rewrite.</p>
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
      socket.emit('start-team-attack', { sessionId, blocksBack });
      $('#teamAttackStats').show();
      showToastNotification('Team attack initiated!', 'success');
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
      socket.emit('propose-hard-fork', { sessionId, height, name });
      showToastNotification('Hard fork proposed to network!', 'success');
    }
  });

  $('#teamAttackStats').after(`
    <hr>
    <h4>Network Topology</h4>
    <div class="form-group">
      <select id="networkModeSelect" class="form-control">
        <option value="simulated-p2p">Simulated P2P (WebSocket Gossip)</option>
        <option value="real-p2p">True P2P (WebRTC Mesh)</option>
      </select>
    </div>
    <div class="alert alert-warning small" style="margin-bottom: 0;">
      <strong>Simulated P2P (Recommended):</strong> Relays gossip messages through the server to bypass school firewalls while mathematically simulating a randomized P2P network.<br><br>
      <strong>True P2P (WebRTC):</strong> Browsers connect directly to each other. <em>Warning: Strict school Wi-Fi firewalls and NATs often block this, causing the network to fragment or fail!</em>
    </div>
  `);
}

function updateDifficultyDisplay() {
  const leading = parseInt($('#difficultyLeading').val());
  const secondary = parseInt($('#difficultySecondary').val());
  
  $('#difficultyLeadingValue').text(leading);
  $('#difficultySecondaryValue').text(secondary.toString(16).toUpperCase());
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
      const orphans = (forksData.success && forksData.forks) ? forksData.forks.orphans : [];
      updateBlockchainView(data.blockchain.chain, orphans);
      updateNetworkStats(data.blockchain);
      updateParticipantsList(data.blockchain);
      updateSettingsDisplay(data.adminSettings);

      // Initialize or update network visualization
      if (networkViz && data.blockchain && data.blockchain.participants) {
        if (data.blockchain.participants.length > 0) {
          // Request peer assignments from the server via socket, which will trigger a topology update
          socket.emit('request-peer-assignments', { sessionId });
        }
      }
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
          txHtml += `<tr><td><code style="font-size: 9px;">${(tx.from||'').substring(0,8)}...</code></td><td><code style="font-size: 9px;">${(tx.to||'').substring(0,8)}...</code></td><td>${tx.amount}</td></tr>`;
        }
        txHtml += `</tbody></table></div>`;
      }

      const forkBadge = (block.forkId && block.forkId !== 'classic') ? `<span class="label label-info pull-right" style="margin-right: 5px;">${block.forkId.toUpperCase()}</span>` : '';
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
            <dt style="width: 80px;">Miner</dt><dd style="margin-left: 90px;"><code style="font-size: 11px;">${block.miner.substring(0, 12)}...</code></dd>
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
            html += `<i class="glyphicon glyphicon-arrow-down" style="display: inline-block; transform: translateX(-10px) rotate(-20deg);"></i>`;
            html += `<i class="glyphicon glyphicon-arrow-down" style="display: inline-block; transform: translateX(10px) rotate(20deg);"></i>`;
          } else {
            const step = 40 / (children.length - 1);
            for (let c = 0; c < children.length; c++) {
              const angle = -20 + (c * step);
              const transX = angle * 0.5;
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
    const nameHtml = p.name ? `<strong style="display:block; margin-bottom:2px;">${p.name}</strong>` : '';
    html += `
      <tr>
        <td>
          ${nameHtml}
          <code style="font-size: 11px; word-break: break-all;">${p.address}</code>
          <button class="btn btn-xs btn-default pull-right copy-btn" data-clipboard-text="${p.address}" title="Copy Address"><i class="glyphicon glyphicon-copy"></i></button>
        </td>
        <td><span class="label ${roleClass}">${roleText}</span></td>
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
