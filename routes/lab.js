var express = require('express');
var router = express.Router();
var { v4: uuidv4 } = require('uuid');

/**
 * Blockchain Lab Routes
 * Handles all HTTP requests for the classroom blockchain lab
 */

// Session storage structure: map of sessionId -> { users: Map, adminToken: string }
let activeSessions = new Map();

/**
 * GET /lab
 * Render the landing page for the blockchain lab
 */
router.get('/', function(req, res, next) {
  res.render('lab/index', { title: 'Blockchain Lab' });
});

/**
 * POST /lab/create
 * Create a new blockchain lab session (admin only)
 */
router.post('/create', function(req, res, next) {
  const app = req.app;
  
  try {
    // Don't pass adminToken - let createSession generate and validate its own
    const result = app.blockchainLab.createSession();

    if (!result) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    // Store session info
    activeSessions.set(result.sessionId, {
      adminToken: result.adminToken,
      users: new Map()
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /lab/join
 * Join an existing session with a join code
 */
router.post('/join', function(req, res, next) {
  const app = req.app;
  const { role } = req.body;
  const joinCode = (req.body.joinCode || '').trim().toUpperCase();
  const userId = req.body.userId || uuidv4();

  if (!joinCode) {
    return res.json({ success: false, error: 'Join code required' });
  }

  try {
    const result = app.blockchainLab.joinSession(joinCode, userId, role || 'wallet');
    
    if (!result.success) {
      return res.json(result);
    }

    // Store user session
    const sessionId = result.sessionId;
    if (!activeSessions.has(sessionId)) {
      activeSessions.set(sessionId, { users: new Map() });
    }

    activeSessions.get(sessionId).users.set(userId, {
      role: role || 'wallet',
      joinedAt: Date.now()
    });

    res.json({ 
      success: true, 
      ...result,
      userId,
      sessionId
    });
  } catch (error) {
    console.error('Error joining session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /lab/session/:sessionId
 * Get current state of a blockchain
 */
router.get('/session/:sessionId', function(req, res, next) {
  const app = req.app;
  const { sessionId } = req.params;

  try {
    const session = app.blockchainLab.sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    res.json({
      success: true,
      blockchain: app.blockchainLab.sanitizeBlockchain(session.blockchain, session.participants),
      adminSettings: app.blockchainLab.adminSettings,
        participantCount: session.participants.size,
        sessionStatus: session.status || 'active'
    });
  } catch (error) {
    console.error('Error getting session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /lab/my-chain/:sessionId/:userId
 * Get the participant's personal blockchain copy
 */
router.get('/my-chain/:sessionId/:userId', function(req, res, next) {
  const app = req.app;
  const { sessionId, userId } = req.params;

  try {
    const session = app.blockchainLab.sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // Initialize participant chain if needed
    const participantChain = app.blockchainLab.getParticipantChain(sessionId, userId);
    
    if (!participantChain) {
      return res.status(404).json({ success: false, error: 'Could not get participant chain' });
    }

    res.json({
      success: true,
      chain: participantChain.chain,                // Blocks on main path
      allBlocks: Array.from(participantChain.allBlocks.values()), // All blocks including forks
      tip: participantChain.tip,
      height: participantChain.height,
      forks: participantChain.forks || []  // Fork information
    });
  } catch (error) {
    console.error('Error getting participant chain:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /lab/sync-chain
 * Sync a participant's personal chain with the network chain (update to heaviest chain)
 */
router.post('/sync-chain', function(req, res, next) {
  const app = req.app;
  const { sessionId, userId, targetChain } = req.body;

  console.log('DEBUG sync-chain:', { sessionId, userId, hasChain: !!targetChain, chainLength: targetChain ? targetChain.length : 'N/A' });

  if (!sessionId || !userId || !targetChain) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  try {
    const blockchain = app.blockchainLab.blockchains.get(sessionId);
    if (!blockchain) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // Update participant's personal chain to match the network chain
    const success = app.blockchainLab.syncParticipantChainFull(sessionId, userId, targetChain);
    
    if (!success) {
      return res.status(400).json({ success: false, error: 'Target chain is incompatible with your Hard Fork rules.' });
    }

    res.json({
      success: true,
      message: 'Personal chain synced with network chain',
      newHeight: targetChain.length
    });
  } catch (error) {
    console.error('Error syncing participant chain:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /lab/forks/:sessionId
 * Get information about orphan blocks and forks
 */
router.get('/forks/:sessionId', function(req, res, next) {
  const app = req.app;
  const { sessionId } = req.params;

  try {
    const session = app.blockchainLab.sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const blockchain = app.blockchainLab.blockchains.get(sessionId);
    const forkInfo = app.blockchainLab.getForkInformation(blockchain);

    res.json({
      success: true,
      forks: forkInfo
    });
  } catch (error) {
    console.error('Error getting fork information:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /lab/validate-block
 * Validate a block without adding it to the chain (for peer validation)
 * This is used by validators to independently verify blocks
 */
router.post('/validate-block', function(req, res, next) {
  const app = req.app;
  const { sessionId, block } = req.body;

  if (!sessionId || !block) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  try {
    const blockchain = app.blockchainLab.blockchains.get(sessionId);
    if (!blockchain) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // Validate without adding
    const validation = app.blockchainLab.validateBlock(blockchain, block);
    
    res.json({
      success: true,
      isValid: validation,
      blockHash: block.hash
    });
  } catch (error) {
    console.error('Error validating block:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /lab/mine
 * Submit a mined block (deprecated - blocks now added via consensus in socketHandlers.js)
 * This endpoint validates the block but does NOT add it to chain - that happens after peer voting
 */
router.post('/mine', function(req, res, next) {
  const app = req.app;
  const { sessionId, block } = req.body;

  if (!sessionId || !block) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  try {
    // IMPORTANT: We do NOT add the block here anymore!
    // The block is only added AFTER peer validators reach consensus via Socket.io
    // This endpoint validates that the block meets difficulty and structural requirements
    // The actual consensus voting happens in socketHandlers.js
    
    const session = app.blockchainLab.sessions.get(sessionId);
    if (!session) {
      return res.status(400).json({ success: false, error: 'Session not found' });
    }

    const blockchain = app.blockchainLab.blockchains.get(sessionId);
    if (!blockchain) {
      return res.status(400).json({ success: false, error: 'Blockchain not initialized' });
    }

    // Basic validation of block structure
    if (!block.hash || !block.nonce || block.index === undefined) {
      return res.status(400).json({ success: false, error: 'Invalid block structure' });
    }

    // NOTE: We don't strictly validate index here anymore
    // because miners may be mining on personal chains that differ from the main chain
    // Full validation happens on the client side with BlockValidator
    // Just check that it's a reasonable block index (not negative)
    if (block.index < 0) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid block index: ${block.index}` 
      });
    }

    // Return success - the block will be validated and added after peer consensus in socketHandlers.js
    res.json({ 
      success: true, 
      message: 'Block valid. Broadcasting to network.',
      block: block 
    });
  } catch (error) {
    console.error('Error processing mined block:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /lab/transaction
 * Submit a transaction
 */
router.post('/transaction', function(req, res, next) {
  const app = req.app;
  const { sessionId, fromUserId, toUserId, amount } = req.body;

  if (!sessionId || !fromUserId || !toUserId || !amount) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  // === VALIDATION ===
  // Check amount is valid
  if (amount === undefined || amount === null || amount <= 0) {
    return res.status(400).json({ 
      error: 'Invalid amount: must be greater than 0' 
    });
  }

  // Check not self-transfer
  if (fromUserId === toUserId) {
    return res.status(400).json({ 
      error: 'Cannot send coins to yourself' 
    });
  }

  // Check session exists
  const session = app.blockchainLab.sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ 
      error: 'Session not found' 
    });
  }

    if (session.status === 'paused') {
      return res.status(400).json({ error: 'Network is paused by Administrator' });
    }

  // Check both users are participants in this session
  if (!session.participants.has(fromUserId)) {
    return res.status(400).json({ 
      error: `Sender (${fromUserId}) not in this session` 
    });
  }

  if (!session.participants.has(toUserId)) {
    return res.status(400).json({ 
      error: `Recipient (${toUserId}) not in this session` 
    });
  }
  // === END VALIDATION ===

  try {
    const result = app.blockchainLab.addTransaction(sessionId, fromUserId, toUserId, amount);
    
    if (result.success && app.io) {
      app.io.to(sessionId).emit('transactionAdded', result.transaction);
    }

    res.json(result);
  } catch (error) {
    console.error('Error adding transaction:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /lab/updateSettings
 * Update admin settings
 */
router.post('/updateSettings', function(req, res, next) {
  const app = req.app;
  const { adminToken, newSettings } = req.body;

  if (!adminToken) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const result = app.blockchainLab.updateAdminSettings(adminToken, newSettings);
    
    if (result.success && app.io) {
      app.io.emit('settingsUpdated', result.settings);
    }

    res.json(result);
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /lab/validator-code
 * Get the BlockValidator source code (for participants to view/modify)
 */
router.get('/validator-code', function(req, res, next) {
  try {
    const fs = require('fs');
    const path = require('path');
    const validatorPath = path.join(__dirname, '../lib/blockValidator.js');
    const code = fs.readFileSync(validatorPath, 'utf8');
    
    res.json({
      success: true,
      filename: 'blockValidator.js',
      code: code,
      description: 'This is the code running on each participant\'s validator node. Modify it to experiment with attacks and forks!',
      keyFunctions: [
        'validateBlockHash() - Verify block hasn\'t been tampered',
        'validateDifficulty() - Check if hash meets PoW requirement',
        'validatePreviousHash() - Check chain linkage (FORK POINT!)',
        'validateTransaction() - Check transaction validity (DOUBLE-SPEND POINT!)',
        'validateFullBlock() - Complete block validation',
        'validateChain() - Validate entire blockchain',
        'enableSoftFork() - Implement backward-compatible change',
        'enableHardFork() - Implement incompatible change'
      ]
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /lab/validator-code
 * NOTE: Manual validator code changes are now client-side only
 * This endpoint is deprecated and kept only for admin-triggered demo code
 * (Admin sends demo code via Socket.io, not HTTP)
 */
router.post('/validator-code', function(req, res, next) {
  try {
    res.json({
      success: false,
      message: 'Manual validator code is now managed client-side only',
      info: 'To change your validation rules, modify the code in your "Your Validator Code" editor.',
      note: 'Admin-triggered simulations will be sent via WebSocket events.'
    });
  } catch (error) {
    console.error('Error with validator-code endpoint:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /lab/demos
 * Admin-triggered simulations now use Socket.io events, not HTTP
 */
router.get('/demos', function(req, res, next) {
  try {
    res.json({
      success: true,
      message: 'Admin simulations are now triggered via WebSocket events',
      demos: [
        { id: '51-percent-attack', name: '51% Attack', type: 'admin-triggered' },
        { id: 'double-spend', name: 'Double Spend', type: 'manual-local' },
        { id: 'hard-fork', name: 'Hard Fork Voting', type: 'both' }
      ],
      note: 'See /lab/validator-code for manual attack simulations (local editor)'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /lab/demos/:demoName
 * Get detailed guide for a specific demo
 */
router.get('/demos/:demoName', function(req, res, next) {
  try {
    const demo = demoSystem.getDemo(req.params.demoName);
    
    if (!demo) {
      return res.status(404).json({ success: false, error: 'Demo not found' });
    }

    res.json({
      success: true,
      demo: demo
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /lab/admin/:sessionId
 * Admin dashboard for a session
 */
router.get('/admin/:sessionId', function(req, res, next) {
  const sessionId = req.params.sessionId;
  res.render('lab/admin', { sessionId, title: 'Blockchain Lab - Admin' });
});

/**
 * GET /lab/observe/:sessionId
 * Wallet view of a blockchain
 */
router.get('/observe/:sessionId', function(req, res, next) {
  const sessionId = req.params.sessionId;
  res.render('lab/observe', { sessionId, title: 'Blockchain Lab - Wallet' });
});

/**
 * GET /lab/participate/:sessionId
 * Participant (miner) view
 */
router.get('/participate/:sessionId', function(req, res, next) {
  const sessionId = req.params.sessionId;
  res.render('lab/participate', { sessionId, title: 'Blockchain Lab - Miner' });
});

/**
 * GET /lab/code/:sessionId
 * Participant code editor view
 */
router.get('/code/:sessionId', function(req, res, next) {
  const sessionId = req.params.sessionId;
  res.render('lab/code-editor', { sessionId, title: 'Blockchain Lab - Code Editor' });
});

/**
 * GET /lab/demos/:sessionId
 * Guided demo view
 */
router.get('/demos-view/:sessionId', function(req, res, next) {
  const sessionId = req.params.sessionId;
  res.render('lab/demos', { sessionId, title: 'Blockchain Lab - Guided Demos' });
});

module.exports = router;
