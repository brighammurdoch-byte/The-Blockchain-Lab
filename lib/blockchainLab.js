const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const MiningUtils = require('./miningUtils');

/**
 * BlockchainLab - Manages an isolated class blockchain network
 * 
 * Features:
 * - Classroom blockchain with admin controls
 * - Real mining simulation with resource limits
 * - 51% attack vulnerability
 * - Student participation and transactions
 */

class BlockchainLab {
  constructor() {
    this.sessions = new Map(); // sessionId -> session data
    this.blockchains = new Map(); // sessionId -> blockchain
    this.adminAuthTokens = new Set(); // Admin authentication
    this.sessionCodes = new Map(); // code -> sessionId (for student join)
    this.DEBUG_MODE = process.env.DEBUG === 'true';
    
    // Session cleanup management
    this.sessionTTL = new Map(); // sessionId -> expiresAt timestamp
    this.SESSION_LIFETIME_MS = parseInt(process.env.SESSION_TTL || '86400000', 10); // From .env or 24 hours default
    this.CLEANUP_INTERVAL_MS = parseInt(process.env.SESSION_CLEANUP_INTERVAL || '1800000', 10); // From .env or 30 minutes default
    
    // Global settings (load from .env or use defaults)
    const difficultyLeading = parseInt(process.env.DIFFICULTY_LEADING_ZEROS || '4', 10);
    const difficultySecondary = parseInt(process.env.DIFFICULTY_SECONDARY || '8', 10);
    
    this.defaultAdminSettings = {
      difficultyLeading: difficultyLeading,
      difficultySecondary: difficultySecondary,
      miningRewardCoins: parseInt(process.env.MINING_REWARD || '10', 10),
      blockTimeTarget: parseInt(process.env.BLOCK_TIME_TARGET || '30000', 10),
      networkMode: 'simulated-p2p', // 'simulated-p2p' or 'real-p2p'
      parametersLocked: false, // If true, don't allow runtime changes
      currentDifficulty: this.calculateDifficulty(difficultyLeading, difficultySecondary)
    };
    
    // Start the cleanup interval
    this.startSessionCleanup();
  }

  /**
   * Create a new classroom blockchain session
   */
  createSession(adminToken) {
    // Generate new admin token if not provided
    if (!adminToken) {
      adminToken = uuidv4();
    }
    
    // Validate/register the token
    const validatedToken = this.validateAdminToken(adminToken);
    if (!validatedToken) {
      return null;
    }

    const sessionId = uuidv4();
    const joinCode = this.generateJoinCode();

    // Register TTL for this session (will be cleaned up after 24 hours)
    this.registerSessionTTL(sessionId);

    const sessionDifficulty = this.calculateDifficulty(
      this.defaultAdminSettings.difficultyLeading,
      this.defaultAdminSettings.difficultySecondary
    );

    const blockchain = {
      chain: [this.createGenesisBlock(sessionDifficulty)], // Main canonical chain
      allBlocks: new Map(), // Hash -> block (includes orphans)
      blockIndex: new Map(), // blockHash -> { block, children: [], isMain: boolean }
      pendingTransactions: [],
      participants: new Map(), // userId -> participant info
      difficulty: sessionDifficulty,
      createdAt: Date.now(),
      networkStats: {
        totalHashrate: 0,
        blockHeight: 1,
        lastBlockTime: Date.now(),
        totalTransactions: 0,
        totalBlocks: 1,
        averageBlockTime: 0,
        forkChains: [], // Array of fork chains { tip: hash, length: num, miners_on_it: count }
        dominant_block: null // Hash of the block that >90% network is on
      }
    };
    
    // Initialize genesis block in allBlocks
    const genesisHash = blockchain.chain[0].hash;
    blockchain.allBlocks.set(genesisHash, blockchain.chain[0]);
    blockchain.blockIndex.set(genesisHash, {
      block: blockchain.chain[0],
      children: [],
      isMain: true,
      broadcastedAt: Date.now()
    });

    const session = {
      id: sessionId,
      joinCode: joinCode,
      blockchain: blockchain,
      status: 'active', // active, paused, ended
      adminToken: validatedToken || adminToken,
      createdAt: Date.now(),
      participants: new Map(), // userId -> {role, info}
      participantChains: new Map(), // userId -> { chain: [], tip: hash, height: number }
      adminSettings: {
        ...this.defaultAdminSettings,
        currentDifficulty: sessionDifficulty
      }
    };

    this.sessions.set(sessionId, session);
    this.blockchains.set(sessionId, blockchain);
    this.sessionCodes.set(joinCode, sessionId);

    return {
      sessionId,
      joinCode,
      adminToken: validatedToken || adminToken,
      blockchain: this.sanitizeBlockchain(blockchain, session.participants)
    };
  }

  /**
   * Get or create a participant's personal blockchain copy
   */
  getParticipantChain(sessionId, userId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (!session.participantChains.has(userId)) {
      // Initialize new participant chain with genesis block
      const blockchain = this.blockchains.get(sessionId);
      const genesisBlock = blockchain.chain[0];
      
      session.participantChains.set(userId, {
        chain: [genesisBlock],        // Blocks on current main path
        allBlocks: new Map([[genesisBlock.hash, genesisBlock]]), // All blocks including forks
        tip: genesisBlock.hash,       // Current tip
        height: 1,
        forks: []                      // Track fork information
      });
    }

    return session.participantChains.get(userId);
  }

  syncParticipantChainFull(sessionId, userId, newChain) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    
    const participantInfo = session.participants.get(userId);
    const myChoice = participantInfo?.forkChoice || 'classic';
    
    // Prevent users from syncing to an incompatible hard fork
    if (session.pendingFork) {
      for (const b of newChain) {
        if (b.index >= session.pendingFork.height && (b.forkId || 'classic') !== myChoice) {
          return false; // Chain has incompatible consensus rules
        }
      }
    }

    // Get or initialize participant chain
    const participantChain = this.getParticipantChain(sessionId, userId);
    if (!participantChain) return false;

    try {
      // Update participant's chain to match the new chain
      participantChain.chain = [...newChain]; // Copy the new chain
      participantChain.height = newChain.length;
      
      // Update the tip to the last block's hash
      if (newChain.length > 0 && newChain[newChain.length - 1].hash) {
        participantChain.tip = newChain[newChain.length - 1].hash;
      }

      // Rebuild allBlocks map with new chain
      participantChain.allBlocks.clear();
      newChain.forEach(block => {
        if (block && block.hash) {
          participantChain.allBlocks.set(block.hash, block);
        }
      });

      if (this.DEBUG_MODE) console.log(`Updated participant ${userId}'s chain to height ${participantChain.height}`);
      return true;
    } catch (error) {
      if (this.DEBUG_MODE) console.error(`Error updating participant chain: ${error.message}`);
      return false;
    }
  }

  /**
   * Update a participant's blockchain with a newly broadcasted block
   * Handles both main chain extensions and fork blocks
   * Returns whether block was added to main path
   */
  updateParticipantChain(sessionId, userId, block) {
    const participantChain = this.getParticipantChain(sessionId, userId);
    if (!participantChain) {
      if (this.DEBUG_MODE) console.log(`  [updateParticipantChain] ${userId}: Failed to get/create chain`);
      return false;
    }
    
    const session = this.sessions.get(sessionId);
    const participantInfo = session?.participants.get(userId);
    const myChoice = participantInfo?.forkChoice || 'classic';
    
    // ENFORCE HARD FORK CONSENSUS: Reject blocks that don't follow our chosen network rules
    if (session?.pendingFork && block.index >= session.pendingFork.height) {
      if ((block.forkId || 'classic') !== myChoice) {
        if (this.DEBUG_MODE) console.log(`  [updateParticipantChain] ${userId}: REJECTED block due to hard fork mismatch`);
        return false; 
      }
    }

    // Check if block already added
    if (participantChain.allBlocks.has(block.hash)) {
      if (this.DEBUG_MODE) console.log(`  [updateParticipantChain] ${userId}: Block already registered`);
      return false;
    }

    // Store all blocks (including forks)
    participantChain.allBlocks.set(block.hash, block);

    // Debug logging
    const prevHashMatch = block.previousHash === participantChain.tip;
    if (this.DEBUG_MODE) {
      console.log(`  [updateParticipantChain] ${userId}: block#${block.index}`);
      console.log(`    Block previousHash: ${block.previousHash.substring(0, 16)}...`);
      console.log(`    Chain tip: ${participantChain.tip.substring(0, 16)}...`);
      console.log(`    Match: ${prevHashMatch}, Chain length: ${participantChain.chain.length}`);
    }

    // Check if this block extends the participant's current chain tip
    if (block.previousHash === participantChain.tip) {
      // This block extends our chain - add to main path
      participantChain.chain.push(block);
      participantChain.tip = block.hash;
      participantChain.height = block.index + 1;
      if (this.DEBUG_MODE) console.log(`  [updateParticipantChain] ${userId}: Block ADDED to main path, new height: ${participantChain.height}`);
      return true;
    } else {
      // REORG LOGIC:
      // Block is a fork. Does it represent a chain that has MORE work (longer) than our current tip?
      const currentTipBlock = participantChain.allBlocks.get(participantChain.tip);
      const currentHeight = currentTipBlock ? currentTipBlock.index : -1;

      if (block.index > currentHeight) {
        // Reorg! This new block's chain is longer.
        if (this.DEBUG_MODE) console.log(`  [updateParticipantChain] ${userId}: REORG DETECTED! Switching to new tip: ${block.hash.substring(0,16)}...`);

        // Rebuild participant chain from genesis
        const newChain = [];
        let curr = block;
        while (curr) {
          newChain.unshift(curr);
          if (curr.index === 0) break; // Reached genesis
          
          let parentHash = curr.previousHash;
          curr = participantChain.allBlocks.get(parentHash);
          
          // If personal chain is missing the block, fetch from network's global memory
          if (!curr) {
            const globalBlockchain = this.blockchains.get(sessionId);
            if (globalBlockchain && globalBlockchain.allBlocks.has(parentHash)) {
              curr = globalBlockchain.allBlocks.get(parentHash);
              participantChain.allBlocks.set(curr.hash, curr);
            }
          }
        }
        
        // Verify we successfully traced all the way back to genesis
        if (newChain.length > 0 && newChain[0].index === 0) {
          participantChain.tip = block.hash;
          participantChain.height = block.index + 1;
          participantChain.chain = newChain;
          return true; // Tip changed
        } else {
          if (this.DEBUG_MODE) console.log(`  [updateParticipantChain] ${userId}: REORG FAILED - Missing ancestor blocks`);
          return false;
        }
      } else {
        // It's a fork, but not longer than our current chain
        if (!participantChain.forks) participantChain.forks = [];
        participantChain.forks.push({
          blockHash: block.hash,
          branchPoint: block.previousHash,
          index: block.index,
          miner: block.miner
        });
        if (this.DEBUG_MODE) console.log(`  [updateParticipantChain] ${userId}: Block registered as FORK (shorter/equal)`);
        return false; // Tip did not change
      }
    }
  }

  /**
   * Join a session with a code
   */
  joinSession(joinCode, userId, role = 'wallet') {
    // Normalize the join code to match storage format
    const normalizedCode = joinCode.trim().toUpperCase();
    const sessionId = this.sessionCodes.get(normalizedCode);
    if (!sessionId) {
      return { success: false, error: 'Invalid join code' };
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    if (session.participants.has(userId)) {
      return { success: false, error: 'User already in session' };
    }

    // Check if this user has previous state from a rejoin
    const existingBlockchainParticipant = session.blockchain.participants.get(userId);
    const existingSessionState = session.previousParticipants && session.previousParticipants.get(userId);
    
    // Restore or create participant state in session
    const participantState = {
      role: role, // 'wallet' or 'miner'
      joinedAt: Date.now(),
      wallet: existingBlockchainParticipant?.balance || 100, // Restore balance if exists
      hashrate: 0,
      blocksMinedCount: existingBlockchainParticipant?.minedBlocks || 0, // Restore mining count
      forkChoice: existingSessionState?.forkChoice || 'classic' // Restore fork choice if existed
    };
    
    session.participants.set(userId, participantState);

    // Initialize or update blockchain participant
    if (!existingBlockchainParticipant) {
      session.blockchain.participants.set(userId, {
        address: userId,
        name: '',
        balance: 100, // Starting balance for new users
        minedBlocks: 0,
        cpuUsage: 0,
        role: role
      });
    } else {
      // Update role if they rejoined
      existingBlockchainParticipant.role = role;
      // Restore their wallet/mining stats
      existingBlockchainParticipant.balance = participantState.wallet;
      existingBlockchainParticipant.minedBlocks = participantState.blocksMinedCount;
    }

    return {
      success: true,
      sessionId,
      blockchain: this.sanitizeBlockchain(session.blockchain, session.participants),
      yourRole: role,
      restoredState: !!existingBlockchainParticipant // Signal if state was restored
    };
  }

  /**
   * Create genesis block
   */
  createGenesisBlock(difficulty) {
    const genesisBlock = {
      index: 0,
      previousHash: '0',
      timestamp: Date.now(),
      nonce: 0,
      transactions: [],
      miner: 'system',
      difficulty: difficulty
    };
    
    // Use canonical hash function consistent with all other blocks
    genesisBlock.hash = MiningUtils.hashBlock(genesisBlock);
    return genesisBlock;
  }

  /**
   * Create a new block
   */
  createBlock(sessionId, minerUserId, transactions = []) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const blockchain = this.blockchains.get(sessionId);
    const previousBlock = blockchain.chain[blockchain.chain.length - 1];
    
    const block = {
      index: blockchain.chain.length,
      timestamp: Date.now(),
      nonce: 0,
      previousHash: previousBlock.hash,
      hash: '',
      transactions: transactions,
      miner: minerUserId,
      difficulty: blockchain.difficulty
    };

    return block;
  }

  /**
   * Mine a block (with actual PoW)
   */
  mineBlock(blockData, maxIterations = 1000000) {
    return MiningUtils.mineBlock(blockData, blockData.difficulty, maxIterations);
  }

  /**
   * Validate if a hash meets the difficulty requirement
   */
  isValidHash(hash, difficulty) {
    return MiningUtils.isValidHash(hash, difficulty);
  }

  /**
   * Add a mined block to the chain
   */
  addBlockToChain(sessionId, block) {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: 'Session not found' };

    const blockchain = this.blockchains.get(sessionId);
    
    // Validate block
    if (!this.validateBlock(blockchain, block)) {
      return { success: false, error: 'Invalid block' };
    }

    blockchain.chain.push(block);
    blockchain.networkStats.totalBlocks++;
    blockchain.networkStats.blockHeight++;
    
    // Guard: only access previous block if chain has at least 2 blocks
    const lastBlock = blockchain.chain.length >= 2 ? blockchain.chain[blockchain.chain.length - 2] : null;
    blockchain.networkStats.lastBlockTime = block.timestamp;
    
    // Only calculate average block time if we have a previous block
    if (lastBlock && blockchain.chain.length >= 2) {
      const timeDiff = block.timestamp - lastBlock.timestamp;
      blockchain.networkStats.averageBlockTime = 
        (blockchain.networkStats.averageBlockTime * (blockchain.networkStats.totalBlocks - 2) +
         timeDiff) / (blockchain.networkStats.totalBlocks - 1);
    }

    // Update miner stats
    const participant = blockchain.participants.get(block.miner);
    if (participant) {
      participant.minedBlocks++;
      participant.balance += session.adminSettings.miningRewardCoins;
    }

    return { success: true, block: block };
  }

  /**
   * Validate a block
   */
  validateBlock(blockchain, block) {
    // Find the parent block to support validating fork branches and personal chains
    const previousBlock = blockchain.allBlocks.get(block.previousHash);
    
    if (!previousBlock && block.index !== 0) {
      console.error(`Previous hash validation failed: parent block not found for hash ${block.previousHash}`);
      return false;
    }

    // Check index relative to its parent
    const expectedIndex = previousBlock ? previousBlock.index + 1 : 0;
    if (block.index !== expectedIndex) {
      console.error(`Block index validation failed: block.index=${block.index}, expected=${expectedIndex}`);
      return false;
    }

    // Check hash validity using proper crypto
    if (!MiningUtils.validateBlockHash(block)) {
      console.error('Hash validation failed - hash does not match recalculated hash');
      console.error(`Block hash: ${block.hash}`);
      console.error(`Block structure:`, JSON.stringify({
        index: block.index,
        timestamp: block.timestamp,
        nonce: block.nonce,
        previousHash: block.previousHash,
        transactions: block.transactions ? block.transactions.length : 0,
        miner: block.miner,
        difficulty: block.difficulty
      }, null, 2));
      return false;
    }

    // Check hash meets difficulty
    if (!this.isValidHash(block.hash, block.difficulty)) {
      console.error(`Difficulty validation failed: block.hash=${block.hash}, difficulty=${JSON.stringify(block.difficulty)}`);
      return false;
    }

    return true;
  }

  /**
   * Register a new block and track if it's on main chain or a fork (orphan)
   */
  registerBlock(sessionId, blockchain, block) {
    // Race condition protection: ensure only one block registers at a time
    if (blockchain._blockRegistrationInProgress) {
      return { success: false, error: 'Block registration in progress', isOrphan: false };
    }

    blockchain._blockRegistrationInProgress = true;

    try {
      // Check if block already registered
      if (blockchain.allBlocks.has(block.hash)) {
        return { success: false, error: 'Block already registered', isOrphan: false };
      }

      // Validate the block
      if (!MiningUtils.validateBlockHash(block)) {
        return { success: false, error: 'Invalid block hash', isOrphan: false };
      }

      // Prevent memory leak from completely detached blocks (DoS protection)
      if (!blockchain.allBlocks.has(block.previousHash) && block.index !== 0) {
        return { success: false, error: 'Previous block not found', isOrphan: false };
      }

      // Check difficulty
      if (!this.isValidHash(block.hash, block.difficulty)) {
        return { success: false, error: 'Does not meet difficulty', isOrphan: false };
      }

      // Register in allBlocks
      blockchain.allBlocks.set(block.hash, block);
      
      const session = this.sessions.get(sessionId);
      const rewardCoins = session ? session.adminSettings.miningRewardCoins : 10;

      // Check if it extends the main chain
      const lastMainBlock = blockchain.chain[blockchain.chain.length - 1];
      const extendsMainChain = (block.previousHash === lastMainBlock.hash);
      
      blockchain.blockIndex.set(block.hash, {
        block: block,
        children: [],
        isMain: extendsMainChain,
        broadcastedAt: Date.now()
      });

      // Register this block as a child of its parent
      if (blockchain.blockIndex.has(block.previousHash)) {
        blockchain.blockIndex.get(block.previousHash).children.push(block.hash);
      }

    if (extendsMainChain) {
      // Add to main chain
      blockchain.chain.push(block);
      blockchain.networkStats.totalBlocks++;
      blockchain.networkStats.blockHeight++;
      
      // Update miner stats
      const participant = blockchain.participants.get(block.miner);
      if (participant) {
        participant.minedBlocks++;
        participant.balance += rewardCoins;
      }
      
      // Process transactions in the block
      this.processBlockTransactions(blockchain, block);
      
      // Clear transactions that were included in this block from mempool
      if (block.transactions && block.transactions.length > 0) {
        const txIds = new Set(block.transactions.map(tx => tx.id || (tx.from + tx.to + tx.amount)));
        blockchain.pendingTransactions = blockchain.pendingTransactions.filter(tx => 
          !txIds.has(tx.id || (tx.from + tx.to + tx.amount))
        );
      }
      
      return { success: true, block: block, isOrphan: false };
    } else if (block.index > lastMainBlock.index) {
      // REORG DETECTED on the global network chain!
      console.log(`Global network chain REORG! Switching to new tip: ${block.hash.substring(0, 16)}...`);
      
      // Rebuild chain from genesis
      const newChain = [];
      let curr = block;
      while (curr) {
        newChain.unshift(curr);
        if (curr.index === 0) break; // Reached genesis
        curr = blockchain.allBlocks.get(curr.previousHash);
      }
      
      // Verify we successfully traced back to genesis
      if (newChain.length > 0 && newChain[0].index === 0) {
        blockchain.chain = newChain;
        blockchain.networkStats.totalBlocks++;
        blockchain.networkStats.blockHeight = block.index + 1;
        
        // Update miner stats
        const participant = blockchain.participants.get(block.miner);
        if (participant) {
          participant.minedBlocks++;
          participant.balance += rewardCoins;
        }
        
        this.processBlockTransactions(blockchain, block);
        
        if (block.transactions && block.transactions.length > 0) {
          const txIds = new Set(block.transactions.map(tx => tx.id || (tx.from + tx.to + tx.amount)));
          blockchain.pendingTransactions = blockchain.pendingTransactions.filter(tx => 
            !txIds.has(tx.id || (tx.from + tx.to + tx.amount))
          );
        }
        
        // Update blockIndex isMain flags
        for (const [hash, info] of blockchain.blockIndex.entries()) {
          info.isMain = false;
        }
        for (const b of newChain) {
          if (blockchain.blockIndex.has(b.hash)) {
            blockchain.blockIndex.get(b.hash).isMain = true;
          }
        }
        
        return { success: true, block: block, isOrphan: false };
      } else {
        console.log(`Global reorg failed - missing ancestor blocks`);
        blockchain.networkStats.totalBlocks++;
        return { success: true, block: block, isOrphan: true };
      }
    } else {
      // This is an orphan block (shorter or equal length fork)
      blockchain.networkStats.totalBlocks++; // Still count the block
      console.log(`Orphan block registered: ${block.hash.substring(0, 16)}... (extends chain at index ${block.index-1})`);
      return { success: true, block: block, isOrphan: true };
    }
    } finally {
      // Always release the lock
      blockchain._blockRegistrationInProgress = false;
    }
  }

  /**
   * Get information about forks/orphan blocks
   */
  getForkInformation(blockchain) {
    const mainChainHashes = new Set(blockchain.chain.map(b => b.hash));
    const orphanBlocks = [];
    const forks = {};
    
    // Find all orphan blocks
    for (const [hash, block] of blockchain.allBlocks) {
      if (!mainChainHashes.has(hash)) {
        orphanBlocks.push({
          hash: block.hash.substring(0, 16),
          index: block.index,
          miner: block.miner,
          timestamp: block.timestamp,
          previousHash: block.previousHash.substring(0, 16)
        });
        
        // Track which fork this belongs to
        let parentHash = block.previousHash;
        let forkPointFound = false;
        let depth = 0;
        
        while (parentHash && !forkPointFound && depth < 100) {
          if (mainChainHashes.has(parentHash)) {
            forkPointFound = true;
            if (!forks[parentHash]) {
              forks[parentHash] = {
                forkPoint: parentHash.substring(0, 16),
                branches: []
              };
            }
            // Populate the branch with the orphan block
            forks[parentHash].branches.push(block.hash.substring(0, 16));
          }
          const parentBlock = blockchain.allBlocks.get(parentHash);
          if (!parentBlock) break;
          parentHash = parentBlock.previousHash;
          depth++;
        }
      }
    }
    
    return {
      orphanCount: orphanBlocks.length,
      orphans: orphanBlocks,
      forks: Object.values(forks),
      mainChainLength: blockchain.chain.length
    };
  }

  /**
   * Process transactions from a block and update balances
   */
  processBlockTransactions(blockchain, block) {
    if (!block.transactions || block.transactions.length === 0) return;

    for (const tx of block.transactions) {
      const sender = blockchain.participants.get(tx.from);
      let receiver = blockchain.participants.get(tx.to);
      
      if (sender) {
        // Deduct from sender
        sender.balance -= tx.amount;
        
        // Create receiver if it doesn't exist
        if (!receiver) {
          receiver = {
            address: tx.to,
            balance: 0,
            minedBlocks: 0,
            cpuUsage: 0,
            role: 'miner' // Default to miner behavior if auto-created
          };
          blockchain.participants.set(tx.to, receiver);
        }
        receiver.balance += tx.amount;
      }
    }
  }

  /**
   * Validate cumulative transaction amounts to prevent double-spending
   * Ensures sender has enough balance for each transaction in sequence
   */
  validateCumulativeBalance(block, blockchain) {
    if (!block.transactions || block.transactions.length === 0) {
      return { valid: true };
    }

    const senderBalances = {}; // Track running balance per sender
    
    // Initialize with current balances
    for (const [userId, participant] of blockchain.participants.entries()) {
      senderBalances[userId] = participant.balance;
    }

    // Process each transaction in order
    for (const tx of block.transactions) {
      if (!senderBalances[tx.from]) {
        senderBalances[tx.from] = 0;
      }

      // Check if sender has enough funds for THIS transaction
      if (senderBalances[tx.from] < tx.amount) {
        return {
          valid: false,
          reason: `Double-spend detected: ${tx.from} tried to send ${tx.amount} but only had ${senderBalances[tx.from]} remaining`,
          failedTxIndex: block.transactions.indexOf(tx)
        };
      }

      // Deduct this transaction
      senderBalances[tx.from] -= tx.amount;
    }

    return { valid: true };
  }

  /**
   * Add a transaction to pending pool
   */
  addTransaction(sessionId, fromUserId, toUserId, amount) {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: 'Session not found' };

    const blockchain = this.blockchains.get(sessionId);
    const sender = blockchain.participants.get(fromUserId);

    // Calculate pending amount to prevent mempool double-spending
    const pendingAmount = blockchain.pendingTransactions
      .filter(tx => tx.from === fromUserId)
      .reduce((sum, tx) => sum + tx.amount, 0);

    if (!sender || sender.balance < (amount + pendingAmount)) {
      return { success: false, error: 'Insufficient balance including pending transactions' };
    }

    const transaction = {
      id: uuidv4(),
      from: fromUserId,
      to: toUserId,
      amount: amount,
      timestamp: Date.now()
    };

    blockchain.pendingTransactions.push(transaction);
    return { success: true, transaction };
  }

  /**
   * Update admin settings
   */
  updateAdminSettings(adminToken, newSettings) {
    let targetSession = null;
    for (const session of this.sessions.values()) {
      if (session.adminToken === adminToken) {
        targetSession = session;
        break;
      }
    }

    if (!targetSession) {
      return { success: false, error: 'Invalid admin token or session expired' };
    }

    if (targetSession.adminSettings.parametersLocked) {
      return { success: false, error: 'Parameters are locked' };
    }

    // Update settings
    if (newSettings.difficultyLeading !== undefined) {
      targetSession.adminSettings.difficultyLeading = newSettings.difficultyLeading;
    }
    if (newSettings.difficultySecondary !== undefined) {
      targetSession.adminSettings.difficultySecondary = newSettings.difficultySecondary;
    }
    if (newSettings.miningRewardCoins !== undefined) {
      targetSession.adminSettings.miningRewardCoins = newSettings.miningRewardCoins;
    }
    if (newSettings.networkMode !== undefined) {
      targetSession.adminSettings.networkMode = newSettings.networkMode;
    }
    if (newSettings.parametersLocked !== undefined) {
      targetSession.adminSettings.parametersLocked = newSettings.parametersLocked;
    }

    // Recalculate difficulty
    targetSession.adminSettings.currentDifficulty = this.calculateDifficulty(
      targetSession.adminSettings.difficultyLeading,
      targetSession.adminSettings.difficultySecondary
    );

    // IMPORTANT: Update the blockchain's difficulty so new blocks use it
    targetSession.blockchain.difficulty = targetSession.adminSettings.currentDifficulty;

    return { success: true, settings: targetSession.adminSettings, sessionId: targetSession.id };
  }

  /**
   * Calculate difficulty object
   */
  calculateDifficulty(leadingZeros, secondaryHex) {
    return {
      leadingZeros: leadingZeros,
      secondaryHex: secondaryHex.toString(16),
      displayName: `${leadingZeros}-bit with 0x${secondaryHex.toString(16)}`
    };
  }

  /**
   * SHA256 hash function
   */
  sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Generate a random 4-6 character code for joining
   */
  generateJoinCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  /**
   * Validate admin token
   */
  validateAdminToken(token) {
    if (!token) {
      const newToken = uuidv4();
      this.adminAuthTokens.add(newToken);
      return newToken;
    }
    // Auto-register the token if not already registered
    if (!this.adminAuthTokens.has(token)) {
      this.adminAuthTokens.add(token);
    }
    return token;
  }

  /**
   * Get sanitized blockchain (remove sensitive data)
   */
  sanitizeBlockchain(blockchain, activeParticipants = null) {
    let participantsList = Array.from(blockchain.participants.entries());
    
    // Filter out disconnected users if the active connection map is provided
    if (activeParticipants) {
      participantsList = participantsList.filter(([address]) => activeParticipants.has(address));
    }

    return {
      chain: blockchain.chain,
      pendingTransactions: blockchain.pendingTransactions,
      networkStats: blockchain.networkStats,
      participants: participantsList.map(([address, p]) => ({
        address,
        name: p.name || '',
        minedBlocks: p.minedBlocks || 0,
        balance: p.balance || 0,
        role: p.role || 'wallet',
        isAttacker: p.isAttacker || false
      }))
    };
  }

  /**
   * Start periodic cleanup of expired sessions
   * Runs every 30 minutes to remove sessions older than 24 hours
   */
  startSessionCleanup() {
    setInterval(() => {
      const now = Date.now();
      let cleanedCount = 0;

      for (const [sessionId, expiresAt] of this.sessionTTL.entries()) {
        if (now > expiresAt) {
          // Session has expired, remove all references
          this.sessions.delete(sessionId);
          this.blockchains.delete(sessionId);
          this.sessionTTL.delete(sessionId);
          
          // Also remove the join code for this session
          for (const [code, sId] of this.sessionCodes.entries()) {
            if (sId === sessionId) {
              this.sessionCodes.delete(code);
              break;
            }
          }
          
          cleanedCount++;
          console.log(`[SessionCleanup] Removed expired session: ${sessionId}`);
        }
      }

      if (cleanedCount > 0) {
        console.log(`[SessionCleanup] Cleaned up ${cleanedCount} expired sessions. Active sessions: ${this.sessions.size}`);
      }
    }, this.CLEANUP_INTERVAL_MS);
  }

  /**
   * Register a new session with TTL
   * Called when creating a new session
   */
  registerSessionTTL(sessionId) {
    const expiresAt = Date.now() + this.SESSION_LIFETIME_MS;
    this.sessionTTL.set(sessionId, expiresAt);
    const hoursUntilExpiry = this.SESSION_LIFETIME_MS / (60 * 60 * 1000);
    console.log(`[SessionCleanup] Session ${sessionId} registered. Will expire in ${hoursUntilExpiry} hours`);
  }
}

module.exports = BlockchainLab;
