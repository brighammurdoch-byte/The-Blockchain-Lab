/**
 * Ethereum-rules engine (teaching twin: accounts, gas, a tiny ERC-20-like contract).
 * Not geth, not the EVM, not solc.
 */
(function (global) {
  var WEI = 1e18;

  function keccakLite(text) {
    // SHA256 stand-in so we do not pull keccak just to hash state
    return CryptoJS.SHA256(String(text)).toString();
  }

  function defaultParams() {
    return {
      initialSupplyEth: 21,
      blockRewardEth: 2,
      transferGas: 21000,
      contractGas: 50000,
      blockGasLimit: 30000000,
      enforceBalance: true,
      enforceNonce: true
    };
  }

  function EthereumChain(params) {
    this.params = Object.assign(defaultParams(), params || {});
    this.accounts = {};
    this.blocks = [];
    this.mempool = [];
    this.contracts = {};
    this.tipHash = '0'.repeat(64);
    this._ensureGenesis();
  }

  EthereumChain.prototype._acct = function (addr) {
    if (!this.accounts[addr]) this.accounts[addr] = { balance: 0, nonce: 0 };
    return this.accounts[addr];
  };

  EthereumChain.prototype._ensureGenesis = function () {
    if (this.blocks.length) return;
    var treasury = '0xTreasury';
    this._acct(treasury).balance = this.params.initialSupplyEth * WEI;
    this.contracts.LabCoin = { name: 'LabCoin', totalSupply: this.params.initialSupplyEth * WEI };
    var genesis = {
      number: 0,
      parentHash: '0'.repeat(64),
      timestamp: Date.now(),
      miner: treasury,
      txs: [],
      gasUsed: 0,
      reward: 0
    };
    genesis.hash = keccakLite(JSON.stringify(genesis));
    this.blocks.push(genesis);
    this.tipHash = genesis.hash;
  };

  EthereumChain.prototype.balanceOf = function (addr) {
    return (this.accounts[addr] && this.accounts[addr].balance) || 0;
  };

  EthereumChain.prototype.tipNumber = function () {
    return this.blocks.length ? this.blocks[this.blocks.length - 1].number : -1;
  };

  EthereumChain.prototype.checkTx = function (tx) {
    var from = this._acct(tx.from);
    if (this.params.enforceNonce && tx.nonce !== from.nonce) {
      return { valid: false, reason: 'bad nonce (got ' + tx.nonce + ', expected ' + from.nonce + ')' };
    }
    var gas = tx.to === 'LabCoin' ? this.params.contractGas : this.params.transferGas;
    if (gas > this.params.blockGasLimit) return { valid: false, reason: 'gas > block limit' };
    if (this.params.enforceBalance && from.balance < tx.value) {
      return { valid: false, reason: 'insufficient balance' };
    }
    return { valid: true, gas: gas };
  };

  EthereumChain.prototype.addTransaction = function (from, to, eth) {
    var value = Math.round(Number(eth) * WEI);
    if (!from || !to || !(value >= 0)) return { ok: false, error: 'invalid tx' };
    var acct = this._acct(from);
    var tx = { from: from, to: to, value: value, nonce: acct.nonce, hash: 'etx-' + Date.now() };
    var chk = this.checkTx(tx);
    if (!chk.valid) return { ok: false, error: chk.reason };
    tx.gas = chk.gas;
    this.mempool.push(tx);
    return { ok: true, tx: tx };
  };

  EthereumChain.prototype.mine = function (miner) {
    miner = miner || '0xValidator';
    var pending = this.mempool.splice(0, 16);
    var gasUsed = 0;
    var applied = [];
    for (var i = 0; i < pending.length; i++) {
      var tx = pending[i];
      var chk = this.checkTx(tx);
      if (!chk.valid) continue;
      if (gasUsed + chk.gas > this.params.blockGasLimit) break;
      var sender = this._acct(tx.from);
      sender.balance -= tx.value;
      sender.nonce += 1;
      this._acct(tx.to).balance += tx.value;
      gasUsed += chk.gas;
      applied.push(tx);
    }
    var reward = this.params.blockRewardEth * WEI;
    this._acct(miner).balance += reward;
    var block = {
      number: this.tipNumber() + 1,
      parentHash: this.tipHash,
      timestamp: Date.now(),
      miner: miner,
      txs: applied,
      gasUsed: gasUsed,
      reward: reward
    };
    block.hash = keccakLite(JSON.stringify(block));
    this.blocks.push(block);
    this.tipHash = block.hash;
    return { ok: true, block: block };
  };

  EthereumChain.prototype.snapshot = function () {
    var tip = this.blocks[this.blocks.length - 1];
    var accounts = this.accounts;
    return {
      number: this.tipNumber(),
      tip: this.tipHash,
      gasLimit: this.params.blockGasLimit,
      rewardEth: this.params.blockRewardEth,
      mempool: this.mempool.length,
      params: this.params,
      blocks: this.blocks.slice(-8),
      accounts: Object.keys(accounts).map(function (k) {
        return { addr: k, eth: accounts[k].balance / WEI, nonce: accounts[k].nonce };
      })
    };
  };

  global.EthereumLab = {
    WEI: WEI,
    defaultParams: defaultParams,
    Chain: EthereumChain
  };
})(typeof window !== 'undefined' ? window : globalThis);
