/**
 * Socket.io handlers for Blockchain Lab
 * Manages real-time communication between admin, observers, and participants
 * Implements proof-of-work with local validation (no voting)
 */

module.exports = function(io, app) {
  // Track active sessions and their participants
  const activeSessions = new Map();
  const DEBUG_MODE = process.env.DEBUG === 'true';

  io.on('connection', (socket) => {
    if (DEBUG_MODE) console.log('New socket connection:', socket.id);

    // ============ SESSION MANAGEMENT ============

    // Admin joins to manage a session
    socket.on('admin-join', (data) => {
      const { sessionId } = data;
      socket.join(`session-${sessionId}`);
      socket.join(`admin-${sessionId}`);
      socket.data = { role: 'admin', sessionId };
      
      if (DEBUG_MODE) console.log(`Admin joined session ${sessionId}`);
      
      // Broadcast that admin is online
      io.to(`session-${sessionId}`).emit('admin-online', {
        message: 'Administrator is online'
      });
    });

    // Wallet joins to watch a session and transact
    socket.on('wallet-join', (data) => {
      const { sessionId, userId } = data;
      socket.join(`session-${sessionId}`);
      socket.join(`wallet-${sessionId}`);
      socket.join(`user-${userId}`);
      socket.data = { role: 'wallet', sessionId, userId };
      
      if (DEBUG_MODE) console.log(`Wallet joined session ${sessionId}`);
      
      // Send current state to the observer
      const session = app.blockchainLab.sessions.get(sessionId);
      if (session) {
        socket.emit('initial-state', {
          adminSettings: app.blockchainLab.adminSettings,
          participants: Array.from(session.participants.entries())
        });
      } else {
        return socket.emit('error', 'Session not found or expired');
      }
      
      // Notify others of new node
      io.to(`session-${sessionId}`).emit('node-joined', {
        userId: userId,
        timestamp: Date.now()
      });
    });

    // Miner joins to mine blocks and validate
    socket.on('miner-join', (data) => {
      const { sessionId, userId } = data;
      socket.join(`session-${sessionId}`);
      socket.join(`miner-${sessionId}`);
      socket.join(`user-${userId}`);
      socket.data = { role: 'miner', sessionId, userId };
      
      if (DEBUG_MODE) console.log(`Miner ${userId} joined session ${sessionId}`);
      
      // Send current state to the participant
      const session = app.blockchainLab.sessions.get(sessionId);
      if (session) {
        // Initialize socket-to-userId mapping if needed
        if (!session.socketToUserId) session.socketToUserId = new Map();
        session.socketToUserId.set(socket.id, userId);
        
        // Assign peers for simulated P2P mode
        const allMiners = io.sockets.adapter.rooms.get(`miner-${sessionId}`);
        const peerSocketList = allMiners ? Array.from(allMiners).filter(id => id !== socket.id) : [];
        
        // Convert socket IDs to userIds for peer assignments
        const assignedPeerSockets = peerSocketList.sort(() => 0.5 - Math.random()).slice(0, 3);
        const newPeers = assignedPeerSockets
          .map(socketId => session.socketToUserId.get(socketId))
          .filter(userId => userId); // Filter out undefined
        
        if (!session.peerAssignments) session.peerAssignments = new Map();
        
        const myPeers = session.peerAssignments.get(userId) || [];
        newPeers.forEach(peerId => {
          if (!myPeers.includes(peerId)) myPeers.push(peerId);
          
          // Ensure bidirectional connection so gossip flows both ways
          const peerOfPeer = session.peerAssignments.get(peerId) || [];
          if (!peerOfPeer.includes(userId)) {
            peerOfPeer.push(userId);
            session.peerAssignments.set(peerId, peerOfPeer);
          }
        });
        session.peerAssignments.set(userId, myPeers);
        
        socket.emit('initial-state', {
          blockchain: app.blockchainLab.sanitizeBlockchain(session.blockchain, session.participants),
          adminSettings: app.blockchainLab.adminSettings,
          role: 'miner',
          assignedPeers: myPeers
        });
        
        // Notify admin of updated peer assignments with node names
        const peerAssignmentsWithNames = Array.from(session.peerAssignments.entries()).map(([userId, peers]) => {
          const participant = session.participants.get(userId);
          const blockchainParticipant = session.blockchain.participants.get(userId);
          const isColluding = session.teams && session.teams.colluders.has(userId);
          return {
            userId,
            name: session.nodeNames?.get(userId) || '',
            peers,
            forkChoice: participant?.forkChoice || 'classic',
            isColluding: isColluding,
            hashrate: blockchainParticipant?.hashrate || 0
          };
        });
        
        io.to(`admin-${sessionId}`).emit('peer-assignments-updated', {
          peerAssignments: peerAssignmentsWithNames
        });
      } else {
        return socket.emit('error', 'Session not found or expired');
      }
      
      // Notify others of new node
      io.to(`session-${sessionId}`).emit('node-joined', {
        userId: userId,
        timestamp: Date.now()
      });
    });
    
    // Handle node name changes (for visualization)
    socket.on('node-name-changed', (data) => {
      const { sessionId, userId, name } = data;
      const session = app.blockchainLab.sessions.get(sessionId);
      
      if (!session || socket.data?.userId !== userId) {
        return socket.emit('error', 'Unauthorized');
      }
      
      // Store node name in session
      if (!session.nodeNames) session.nodeNames = new Map();
      session.nodeNames.set(userId, name);
      
      // Add to blockchain participants so it shows up in the general participant list
      const blockchainParticipant = session.blockchain.participants.get(userId);
      if (blockchainParticipant) {
        blockchainParticipant.name = name;
      }
      
      if (DEBUG_MODE) console.log(`Node ${userId} renamed to: ${name}`);
      
      // Broadcast to admin dashboard
      io.to(`admin-${sessionId}`).emit('node-name-changed', {
        userId: userId,
        name: name,
        timestamp: Date.now()
      });
    });

    // ============ P2P BLOCK PROPAGATION (Nakamoto Consensus) ============

    // Miner broadcasts a newly found block to the network
    // Server does NOT validate - clients validate independently
    socket.on('block-found', async (data) => {
      const { sessionId, block } = data;
      const minerId = socket.data?.userId;
      
      if (!minerId || socket.data?.sessionId !== sessionId) {
        return socket.emit('error', 'Unauthorized');
      }

      const session = app.blockchainLab.sessions.get(sessionId);
      if (!session) {
        return socket.emit('block-error', { error: 'Session not found' });
      }
      
      if (session.status === 'paused') {
        return socket.emit('block-error', { error: 'Network is paused by Administrator' });
      }
      
      if (DEBUG_MODE) console.log(`Block found by ${minerId}: ${block.hash.substring(0, 16)}... Broadcasting to peers.`);
      
      // 1. MINER AUTONOMY: Update the miner's personal chain immediately.
      const tipChanged = app.blockchainLab.updateParticipantChain(sessionId, minerId, block);
      if (tipChanged) {
        socket.emit('chain-updated', { block, reason: 'mined', minerId });
      } else {
        socket.emit('chain-updated', { block, reason: 'fork-stored', minerId });
      }
      
      // 2. PASSIVE TRACKER: Register it on the server purely so Observers/Wallets have a visual map.
      const blockchain = app.blockchainLab.blockchains.get(sessionId);
      const registerResult = app.blockchainLab.registerBlock(blockchain, block);

      // 3. NETWORK PROPAGATION: Send ONLY to assigned peers
      const networkMode = app.blockchainLab.adminSettings.networkMode || 'simulated-p2p';
      if (networkMode === 'simulated-p2p') {
        const myPeers = session.peerAssignments?.get(minerId) || [];
        myPeers.forEach(peerId => {
          io.to(`user-${peerId}`).emit('peer-block-received', { block, minerId });
        });
      }
      
      // Notify wallets/observers so they can see the new block
      io.to(`wallet-${sessionId}`).emit('block-broadcast', {
        block: block,
        minerId: minerId,
        isOrphan: registerResult ? registerResult.isOrphan : false,
        broadcastedAt: Date.now()
      });
      
      // Notify admin for visualization
      const peerList = session.peerAssignments ? session.peerAssignments.get(minerId) : [];
      
      io.to(`admin-${sessionId}`).emit('block-found-visualization', {
        blockHash: block.hash.substring(0, 16),
        minerId: minerId,
        blockHeight: block.index,
        peerList: peerList || [],
        timestamp: Date.now()
      });
    });

    // Process a peer-received block on the server side
    // This adds the block to the SHARED blockchain so all nodes see it
    // The validator decision happens on the CLIENT side only
    socket.on('process-peer-block', async (data) => {
      const { sessionId, block, minerId } = data;
      
      if (!sessionId || !block) return;
      
      const session = app.blockchainLab.sessions.get(sessionId);
      if (!session) return;
      
      if (DEBUG_MODE) console.log(`Processing peer block for shared blockchain: ${block.hash.substring(0, 16)}...`);
      
      try {
        // Always update the shared blockchain (consensus view) - this is what other nodes see
        const blockchain = app.blockchainLab.blockchains.get(sessionId);
        if (blockchain) {
          const registerResult = app.blockchainLab.registerBlock(blockchain, block);
          if (DEBUG_MODE) {
            const status = registerResult?.isOrphan ? 'orphan/fork' : 'on main chain';
            console.log(`  Block registered in shared chain as ${status}`);
          }
        }
      } catch (error) {
        console.error('Error processing peer block:', error);
      }
    });

    // When a CLIENT's validator accepts a block, it tells the server to add it to the client's PERSONAL chain
    // This way, the validator (which runs on the client) controls what's in the client's personal chain
    socket.on('add-to-personal-chain', async (data) => {
      const { sessionId, block, minerId } = data;
      const userId = socket.data?.userId;
      
      if (!userId || !sessionId || !block) return;
      
      const session = app.blockchainLab.sessions.get(sessionId);
      if (!session) return;
      
      if (DEBUG_MODE) console.log(`Adding block to ${userId}'s personal chain: ${block.hash.substring(0, 16)}...`);
      
      try {
        const tipChanged = app.blockchainLab.updateParticipantChain(sessionId, userId, block);
        
        if (tipChanged) {
          socket.emit('chain-updated', { block, reason: 'peer-accepted', minerId });
        } else {
          socket.emit('fork-stored', { block });
        }
      } catch (error) {
        console.error('Error adding block to personal chain:', error);
      }
    });
    
    // NOTE: Block validation now happens on the client-side with BlockValidator
    // Clients independently validate and add blocks to their own chains
    // Server updates both: shared blockchain (always) and personal chains (if validator accepts)

    // Receive a gossip message and randomly forward it to simulate mesh propagation
    socket.on('gossip-forward', async (data) => {
      const { sessionId, block, minerId } = data;
      const userId = socket.data?.userId;
      const session = app.blockchainLab.sessions.get(sessionId);
      if (!session) return;
      
      if (app.blockchainLab.adminSettings.networkMode === 'simulated-p2p') {
        const myPeers = session.peerAssignments?.get(userId) || [];
        
        myPeers.forEach(peerId => {
          io.to(`user-${peerId}`).emit('peer-block-received', { block, minerId });
        });
      }
    });

    // ============ TRUE P2P WEBRTC SIGNALING ============
    socket.on('request-webrtc-peers', async (data) => {
      const { sessionId } = data;
      const allMiners = await io.in(`miner-${sessionId}`).fetchSockets();
      // Give the client up to 3 random peer socket IDs to connect to
      const peers = allMiners.filter(s => s.id !== socket.id).map(s => s.id);
      const selected = peers.sort(() => 0.5 - Math.random()).slice(0, 3);
      socket.emit('webrtc-peers', selected);
    });
    socket.on('webrtc-offer', (data) => {
      socket.to(data.target).emit('webrtc-offer', { offer: data.offer, from: socket.id });
    });
    socket.on('webrtc-answer', (data) => {
      socket.to(data.target).emit('webrtc-answer', { answer: data.answer, from: socket.id });
    });
    socket.on('webrtc-ice', (data) => {
      socket.to(data.target).emit('webrtc-ice', { candidate: data.candidate, from: socket.id });
    });

    // Miner reports which block they're currently mining on
    // Used to track network consensus and determine which chain is dominant
    socket.on('mining-on-block', (data) => {
      const { sessionId, blockHash, minerAddress } = data;
      const minerId = socket.data?.userId;
      
      if (!minerId || socket.data?.sessionId !== sessionId) {
        return socket.emit('error', 'Unauthorized');
      }

      // Broadcast mining status to all participants in the session
      // This allows observers to see which blocks miners are working on
      io.to(`session-${sessionId}`).emit('miner-status-update', {
        minerId: minerId,
        blockHash: blockHash.substring(0, 16),
        timestamp: Date.now()
      });
      
      if (DEBUG_MODE) console.log(`${minerId} is mining on block ${blockHash.substring(0, 16)}...`);
    });

    // ============ TRANSACTIONS ============

    // Handle transaction broadcasting
    socket.on('transaction-sent', (data) => {
      const { sessionId, transaction } = data;
      
      // Broadcast to all participants
      io.to(`session-${sessionId}`).emit('transactionAdded', transaction);
      
      if (DEBUG_MODE) console.log(`Transaction from ${transaction.from} in session ${sessionId}`);
    });

    // ============ ADMIN CONTROLS ============

    // Admin updates settings
    socket.on('settings-changed', (data) => {
      const { sessionId, settings } = data;
      
      if (socket.data?.role !== 'admin') {
        return socket.emit('error', 'Only admin can change settings');
      }

      // Broadcast new settings to all participants
      io.to(`session-${sessionId}`).emit('settingsUpdated', settings);
      
      if (DEBUG_MODE) console.log(`Settings updated in session ${sessionId}`);
    });

    // Admin toggles network pause/resume
    socket.on('toggle-network', (data) => {
      const { sessionId, paused } = data;
      if (socket.data?.role !== 'admin') return;
      
      const session = app.blockchainLab.sessions.get(sessionId);
      if (session) {
        session.status = paused ? 'paused' : 'active';
        io.to(`session-${sessionId}`).emit('network-toggled', { paused });
      }
    });

    // Admin initiates Team 51% Attack with modified validator code
    socket.on('start-team-attack', async (data) => {
      const { sessionId, blocksBack, modifiedCode } = data;
      if (socket.data?.role !== 'admin') return;
      
      const session = app.blockchainLab.sessions.get(sessionId);
      if (!session) return;
      
      const participants = Array.from(session.participants.keys());
      // Shuffle and split ~50/50
      participants.sort(() => 0.5 - Math.random());
      const colluders = participants.slice(0, Math.ceil(participants.length / 2));
      const honest = participants.slice(Math.ceil(participants.length / 2));
      
      const blockchain = session.blockchain;
      const currentHeight = blockchain.chain.length - 1;
      const appliesAtBlock = currentHeight + blocksBack; // Apply code this many blocks ahead
      
      // Fallback code if not provided by admin
      const attackCode = modifiedCode || '// Attack Validator\nreturn { _broken: true };';

      // Save teams for hashrate tracking
      session.teams = { colluders: new Set(colluders), honest: new Set(honest) };
      
      // Get all connected miners to find attackers
      const allMiners = await io.in(`miner-${sessionId}`).fetchSockets();
      
      // Send attack code to colluding nodes
      allMiners.forEach(minerSocket => {
        const minerId = minerSocket.data?.userId;
        if (colluders.includes(minerId)) {
          minerSocket.emit('attack-coordinated', {
            simulationType: '51-percent-attack',
            role: 'attacker',
            attackersTeam: colluders,
            applyAtBlock: appliesAtBlock,
            modifiedCode: attackCode,
            codeDiff: `// Modified validator restricts block acceptance\n// Will be applied at block ${appliesAtBlock}`
          });
        } else if (honest.includes(minerId)) {
          minerSocket.emit('attack-coordinated', {
            role: 'honest',
            attackersTeam: colluders,
            applyAtBlock: appliesAtBlock,
            message: 'Other nodes are attacking. Monitor for chain divergence.'
          });
        }
      });
      
      io.to(`admin-${sessionId}`).emit('attack-started', { colluders, honest, appliesAtBlock });
      if (DEBUG_MODE) console.log(`51% attack started in session ${sessionId}. Colluders: ${colluders.join(', ')}, applies at block ${appliesAtBlock}`);
    });
    
    // Admin initiates Hard Fork Simulation
    socket.on('propose-hard-fork', (data) => {
      const { sessionId, height, name } = data;
      if (socket.data?.role !== 'admin') return;
      
      const session = app.blockchainLab.sessions.get(sessionId);
      if (!session) return;
      
      session.pendingFork = { height, name };
      io.to(`session-${sessionId}`).emit('hard-fork-proposed', { height, name });
    });
    
    // Miner votes on Hard Fork (switches which fork they'll mine on)
    socket.on('hard-fork-vote', (data) => {
      const { sessionId, choice } = data;
      const userId = socket.data?.userId;
      const session = app.blockchainLab.sessions.get(sessionId);
      if (session && userId && session.participants.has(userId)) {
        // Update active participant state
        session.participants.get(userId).forkChoice = choice;
        
        // New blocks mined after this will use the new forkChoice
        // Existing blocks are not retroactively changed
        
        if (DEBUG_MODE) console.log(`${userId} switched to ${choice} fork`);
        
        // Broadcast to observers
        io.to(`wallet-${sessionId}`).emit('miner-fork-choice', {
          userId: userId,
          choice: choice,
          timestamp: Date.now(),
          message: `${userId} is now mining on the ${choice} fork`
        });
      }
    });

    // Provide network topology to admin dashboard
    socket.on('request-peer-assignments', (data) => {
      const { sessionId } = data;
      if (socket.data?.role !== 'admin') return;
      
      const session = app.blockchainLab.sessions.get(sessionId);
      if (session && session.peerAssignments) {
        const peerAssignmentsWithNames = Array.from(session.peerAssignments.entries()).map(([userId, peers]) => {
          const participant = session.participants.get(userId);
          const blockchainParticipant = session.blockchain.participants.get(userId);
          const isColluding = session.teams && session.teams.colluders.has(userId);
          return {
            userId,
            name: session.nodeNames?.get(userId) || '',
            peers,
            forkChoice: participant?.forkChoice || 'classic',
            isColluding: isColluding,
            hashrate: blockchainParticipant?.hashrate || 0
          };
        });
        
        socket.emit('peer-assignments-updated', {
          peerAssignments: peerAssignmentsWithNames
        });
      }
    });

    // ============ UTILITY HANDLERS ============

    // Request current blockchain state
    socket.on('request-state', (data) => {
      const { sessionId } = data;
      
      const session = app.blockchainLab.sessions.get(sessionId);
      if (session) {
        socket.emit('blockchain-state', {
          blockchain: app.blockchainLab.sanitizeBlockchain(session.blockchain, session.participants),
          adminSettings: app.blockchainLab.adminSettings,
          participants: Array.from(session.participants.entries()).map(([id, p]) => ({ id, ...p }))
        });
      }
    });

    // Periodic hashrate updates from participants
    socket.on('hashrate-update', (data) => {
      const { sessionId, hashrate } = data;
      const userId = socket.data?.userId;
      
      if (!userId) return;

      const session = app.blockchainLab.sessions.get(sessionId);
      if (session) {
        const participant = session.blockchain.participants.get(userId);
        if (participant) {
          participant.hashrate = hashrate;
          
          // Recalculate network hashrate
          let totalHashrate = 0;
          session.blockchain.participants.forEach(p => {
            totalHashrate += p.hashrate || 0;
          });
          session.blockchain.networkStats.totalHashrate = totalHashrate;
          
          // Broadcast updated stats
          io.to(`session-${sessionId}`).emit('hashrate-updated', {
            userId: userId,
            hashrate: hashrate,
            networkTotal: totalHashrate
          });
          
          // Emit aggregate team hashrate if a team attack is actively running
          if (session.teams) {
            let colludeH = 0, honestH = 0;
            session.blockchain.participants.forEach((p, id) => {
              if (session.teams.colluders.has(id)) colludeH += p.hashrate || 0;
              else if (session.teams.honest.has(id)) honestH += p.hashrate || 0;
            });
            io.to(`admin-${sessionId}`).emit('team-hashrate-update', { colludeH, honestH });
          }
        }
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      const { sessionId, userId, role } = socket.data || {};
      
      if (sessionId) {
        const session = app.blockchainLab.sessions.get(sessionId);
        if (session && userId) {
          // Save previous state before removing from active participants
          const participantState = session.participants.get(userId);
          if (participantState) {
            if (!session.previousParticipants) session.previousParticipants = new Map();
            session.previousParticipants.set(userId, {
              wallet: participantState.wallet,
              blocksMinedCount: participantState.blocksMinedCount,
              forkChoice: participantState.forkChoice,
              lastActive: Date.now()
            });
          }
          
          // Remove from active participants
          session.participants.delete(userId);
          
          // Notify others
          io.to(`session-${sessionId}`).emit('node-left', {
            userId: userId,
            timestamp: Date.now()
          });
          
          // Notify admin for visualization
          io.to(`admin-${sessionId}`).emit('node-offline', {
            userId: userId,
            timestamp: Date.now()
          });
        }
      }
      
      console.log(`Socket disconnected: ${socket.id} (${role || 'unknown'})`);
    });

    // Error handling
    socket.on('error', (error) => {
      console.error(`Socket error: ${error}`);
    });
  });
};
