var express = require('express');
var router = express.Router();
var async = require('async');

router.get('/', function(req, res, next) {
  res.redirect('/lab');
});

router.get('/bitcoin/rules', function(req, res) {
  res.render('lab/bitcoin-rules', { page: 'bitcoin', title: 'Bitcoin-like C++ rules', sessionId: '', bodyClass: 'lab-app' });
});

router.get('/bitcoin', function(req, res) {
  res.render('lab/bitcoin', { page: 'bitcoin', title: 'Bitcoin Lab', sessionId: '', bodyClass: 'lab-app' });
});

router.get('/ethereum/rules', function(req, res) {
  res.render('lab/ethereum-rules', { page: 'ethereum', title: 'Ethereum-like Solidity rules', sessionId: '', bodyClass: 'lab-app' });
});

router.get('/ethereum', function(req, res) {
  res.render('lab/ethereum', { page: 'ethereum', title: 'Ethereum Lab', sessionId: '', bodyClass: 'lab-app' });
});

router.get('/:page', function(req, res, next) {
    if (req.params.page === 'lab') {
      // Let the /lab mount handle this
      return next();
    }
    res.render(req.params.page, {page: req.params.page});
});

module.exports = router;
