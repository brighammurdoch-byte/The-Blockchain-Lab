/**
 * Bitcoin-rules engine (teaching twin of Core consensus, not bitcoind).
 * SHA256d, UTXO, subsidy/halving, retarget. Classroom time is scaled.
 */
(function (global) {
  var COIN = 100000000;

  function sha256d(text) {
    var a = CryptoJS.SHA256(String(text)).toString();
    return CryptoJS.SHA256(a).toString();
  }

  function defaultParams() {
    return {
      subsidyCoins: 50,
      halvingInterval: 210000,
      // Core: 2016 blocks / 1,209,600s. Lab uses a shorter interval so class
      // can see a retarget. The C++ still names the Core constants.
      difficultyInterval: 20,
      targetSpacingSec: 8,
      coinbaseMaturity: 10,
      maxMoneyCoins: 21000000,
      checkMaxMoney: true,
      checkEmptyVin: true,
      powLeadingZeros: 3
    };
  }

  function getSubsidy(height, p) {
    var halvings = Math.floor(Math.max(0, height) / p.halvingInterval);
    if (halvings >= 64) return 0;
    var n = p.subsidyCoins * COIN;
    n = Math.floor(n / Math.pow(2, halvings));
    return n;
  }

  function BitcoinChain(params) {
    this.params = Object.assign(defaultParams(), params || {});
    this.utxos = {};
    this.blocks = [];
    this.mempool = [];
    this.tipHash = '0'.repeat(64);
    this._ensureGenesis();
  }

  BitcoinChain.prototype._ensureGenesis = function () {
    if (this.blocks.length) return;
    var genesis = {
      height: 0,
      previousHash: '0'.repeat(64),
      timestamp: Date.now(),
      nonce: 0,
      txs: [{
        txid: 'genesis-coinbase',
        coinbase: true,
        vin: [],
        vout: [{ n: 0, value: getSubsidy(0, this.params), address: 'satoshi' }]
      }],
      miner: 'satoshi',
      subsidy: getSubsidy(0, this.params)
    };
    genesis.hash = this._hashBlock(genesis);
    this.blocks.push(genesis);
    this.tipHash = genesis.hash;
    this._applyTxs(genesis.txs, genesis.height);
  };

  BitcoinChain.prototype._hashBlock = function (block) {
    return sha256d([
      block.height,
      block.previousHash,
      block.timestamp,
      block.nonce,
      JSON.stringify(block.txs)
    ].join('|'));
  };

  BitcoinChain.prototype._meetsPow = function (hash) {
    var z = this.params.powLeadingZeros || 3;
    return hash.slice(0, z) === new Array(z + 1).join('0');
  };

  BitcoinChain.prototype._applyTxs = function (txs, height) {
    var self = this;
    txs.forEach(function (tx) {
      (tx.vin || []).forEach(function (input) {
        delete self.utxos[input.txid + ':' + input.vout];
      });
      (tx.vout || []).forEach(function (out) {
        self.utxos[tx.txid + ':' + out.n] = {
          value: out.value,
          address: out.address,
          height: height,
          coinbase: !!tx.coinbase
        };
      });
    });
  };

  BitcoinChain.prototype.balanceOf = function (address) {
    var sum = 0;
    var height = this.tipHeight();
    var maturity = this.params.coinbaseMaturity;
    Object.keys(this.utxos).forEach(function (k) {
      var u = this.utxos[k];
      if (u.address !== address) return;
      if (u.coinbase && (height - u.height) < maturity) return;
      sum += u.value;
    }, this);
    return sum;
  };

  BitcoinChain.prototype.tipHeight = function () {
    return this.blocks.length ? this.blocks[this.blocks.length - 1].height : -1;
  };

  BitcoinChain.prototype.spendable = function (address) {
    var out = [];
    var height = this.tipHeight();
    var maturity = this.params.coinbaseMaturity;
    Object.keys(this.utxos).forEach(function (k) {
      var u = this.utxos[k];
      if (u.address !== address) return;
      if (u.coinbase && (height - u.height) < maturity) return;
      var parts = k.split(':');
      out.push({ txid: parts[0], vout: parseInt(parts[1], 10), value: u.value, address: u.address });
    }, this);
    return out;
  };

  BitcoinChain.prototype.checkTransaction = function (tx) {
    if (tx.coinbase) {
      if (this.params.checkEmptyVin && tx.vin && tx.vin.length) {
        return { valid: false, reason: 'coinbase must have empty vin' };
      }
      return { valid: true };
    }
    if (this.params.checkEmptyVin && (!tx.vin || !tx.vin.length)) {
      return { valid: false, reason: 'vin empty' };
    }
    var seen = {};
    var inSum = 0;
    for (var i = 0; i < (tx.vin || []).length; i++) {
      var input = tx.vin[i];
      var key = input.txid + ':' + input.vout;
      if (seen[key]) return { valid: false, reason: 'duplicate input' };
      seen[key] = true;
      var utxo = this.utxos[key];
      if (!utxo) return { valid: false, reason: 'missing input ' + key };
      if (utxo.coinbase && (this.tipHeight() - utxo.height) < this.params.coinbaseMaturity) {
        return { valid: false, reason: 'immature coinbase' };
      }
      inSum += utxo.value;
    }
    var outSum = 0;
    (tx.vout || []).forEach(function (o) { outSum += o.value; });
    if (outSum <= 0) return { valid: false, reason: 'no outputs' };
    if (outSum > inSum) return { valid: false, reason: 'in < out' };
    if (this.params.checkMaxMoney && outSum > this.params.maxMoneyCoins * COIN) {
      return { valid: false, reason: 'nValueOut > MAX_MONEY' };
    }
    return { valid: true };
  };

  BitcoinChain.prototype.addTransaction = function (from, to, coins) {
    var value = Math.round(Number(coins) * COIN);
    if (!from || !to || !(value > 0)) return { ok: false, error: 'invalid send' };
    var utxos = this.spendable(from);
    var selected = [];
    var total = 0;
    for (var i = 0; i < utxos.length && total < value; i++) {
      selected.push(utxos[i]);
      total += utxos[i].value;
    }
    if (total < value) return { ok: false, error: 'insufficient mature funds' };
    var tx = {
      txid: 'tx-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8),
      coinbase: false,
      vin: selected.map(function (u) { return { txid: u.txid, vout: u.vout }; }),
      vout: [{ n: 0, value: value, address: to }]
    };
    if (total > value) {
      tx.vout.push({ n: 1, value: total - value, address: from });
    }
    var check = this.checkTransaction(tx);
    if (!check.valid) return { ok: false, error: check.reason };
    this.mempool.push(tx);
    return { ok: true, tx: tx };
  };

  BitcoinChain.prototype.mine = function (minerAddress) {
    var height = this.tipHeight() + 1;
    var subsidy = getSubsidy(height, this.params);
    var fees = 0;
    var pending = this.mempool.splice(0, 8);
    pending.forEach(function (tx) {
      var ins = 0;
      var outs = 0;
      var self = this;
      (tx.vin || []).forEach(function (input) {
        var u = self.utxos[input.txid + ':' + input.vout];
        if (u) ins += u.value;
      });
      (tx.vout || []).forEach(function (o) { outs += o.value; });
      if (ins > outs) fees += (ins - outs);
    }, this);
    var coinbase = {
      txid: 'cb-' + height + '-' + Date.now(),
      coinbase: true,
      vin: [],
      vout: [{ n: 0, value: subsidy + fees, address: minerAddress || 'miner' }]
    };
    var block = {
      height: height,
      previousHash: this.tipHash,
      timestamp: Date.now(),
      nonce: 0,
      txs: [coinbase].concat(pending),
      miner: minerAddress || 'miner',
      subsidy: subsidy
    };
    var max = 400000;
    for (var n = 0; n < max; n++) {
      block.nonce = n;
      block.hash = this._hashBlock(block);
      if (this._meetsPow(block.hash)) break;
    }
    if (!this._meetsPow(block.hash)) return { ok: false, error: 'pow not found (raise difficulty interval or lower zeros)' };
    var self = this;
    for (var t = 0; t < block.txs.length; t++) {
      var chk = this.checkTransaction(block.txs[t]);
      if (!chk.valid) return { ok: false, error: chk.reason };
    }
    if (block.previousHash !== this.tipHash) return { ok: false, error: 'stale tip' };
    this.blocks.push(block);
    this.tipHash = block.hash;
    this._applyTxs(block.txs, block.height);
    return { ok: true, block: block };
  };

  BitcoinChain.prototype.snapshot = function () {
    var tip = this.blocks[this.blocks.length - 1];
    return {
      height: this.tipHeight(),
      tip: this.tipHash,
      subsidyBtc: getSubsidy(this.tipHeight() + 1, this.params) / COIN,
      utxos: Object.keys(this.utxos).length,
      mempool: this.mempool.length,
      params: this.params,
      blocks: this.blocks.slice(-8),
      nextHalving: this.params.halvingInterval - (this.tipHeight() % this.params.halvingInterval)
    };
  };

  global.BitcoinLab = {
    COIN: COIN,
    defaultParams: defaultParams,
    getSubsidy: getSubsidy,
    sha256d: sha256d,
    Chain: BitcoinChain
  };
})(typeof window !== 'undefined' ? window : globalThis);
