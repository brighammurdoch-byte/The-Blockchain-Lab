var express = require('express');
var router = express.Router();
var async = require('async');

router.get('/', function(req, res, next) {
  res.redirect('/lab');
});

router.get('/:page', function(req, res, next) {
    if (req.params.page === 'lab') {
      // Let the /lab mount handle this
      return next();
    }
    res.render(req.params.page, {page: req.params.page});
});

module.exports = router;
