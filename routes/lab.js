var express = require('express');
var router = express.Router();
var GuidedDemoSystem = require('../lib/guidedDemos');
var demoSystem = new GuidedDemoSystem();

function demoCatalog() {
  return Object.keys(demoSystem.demos).map(function (id) {
    return Object.assign({ id: id }, demoSystem.demos[id]);
  });
}

/**
 * Blockchain Lab Routes (pure client-relay / admin-hub mode only)
 * No server-side blockchain state or coordination. The server just serves the pages + the validator code for the editor tab.
 */

router.get('/', function(req, res, next) {
  res.render('lab/index', { title: 'Blockchain Lab' });
});

router.get('/admin/:sessionId', function(req, res, next) {
  const sessionId = req.params.sessionId;
  res.render('lab/admin', { sessionId, title: 'Blockchain Lab - Admin' });
});

router.get('/participate/:sessionId', function(req, res, next) {
  const sessionId = req.params.sessionId;
  res.render('lab/participate', { sessionId, title: 'Blockchain Lab - Miner' });
});

router.get('/observe/:sessionId', function(req, res, next) {
  const sessionId = req.params.sessionId;
  res.render('lab/observe', { sessionId, title: 'Blockchain Lab - Wallet' });
});

router.get('/code/:sessionId', function(req, res, next) {
  const sessionId = req.params.sessionId;
  res.render('lab/code-editor', { sessionId, title: 'Blockchain Lab - Code Editor' });
});

// Guided demos (static educational content; session optional)
// Supports ?format=json for the demos browser page (client-relay has no dynamic list)
router.get('/demos', function(req, res, next) {
  if (req.query.format === 'json' || (req.headers.accept || '').includes('application/json')) {
    return res.json({ success: true, demos: demoCatalog() });
  }
  res.render('lab/demos', { title: 'Blockchain Lab - Guided Demos' });
});
router.get('/demos/:sessionId', function(req, res, next) {
  const sessionId = req.params.sessionId;
  if (req.query.format === 'json' || (req.headers.accept || '').includes('application/json')) {
    const found = demoSystem.getDemo(sessionId);
    if (found) return res.json({ success: true, demo: Object.assign({ id: sessionId }, found) });
    return res.json({ success: true, demos: demoCatalog() });
  }
  res.render('lab/demos', { sessionId, title: 'Blockchain Lab - Guided Demos' });
});

/**
 * GET /lab/validator-code
 * Serves the validator source so the "Your Validator Code" editor tab can load it (client-side only).
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
      description: 'Client-side only (admin-relay mode). Edit this in the "Your Validator Code" tab to experiment with attacks, double-spends, soft/hard forks, etc.',
      keyFunctions: [
        'validateBlockHash()',
        'validateDifficulty()',
        'validatePreviousHash()',
        'validateTransaction()',
        'validateFullBlock()',
        'validateChain()',
        'enableSoftFork() / enableHardFork()'
      ]
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /lab/validator-code (kept as no-op for the deprecated manual upload button)
 */
router.post('/validator-code', function(req, res, next) {
  res.json({
    success: false,
    message: 'Manual upload is disabled. All validator changes are done live in the editor (client-side).'
  });
});

module.exports = router;
