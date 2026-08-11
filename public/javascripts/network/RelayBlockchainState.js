/**
 * RelayBlockchainState
 *
 * Lightweight in-memory blockchain for the Admin when running in client-relay mode.
 * The admin's browser becomes the source of truth / canonical chain for the room.
 *
 * Goals:
 * - Simple but functional for classroom demos
 * - Support block submission from miners via the relay
 * - Send consistent initial state to newly joined peers
 * - Broadcast updates when the chain grows
 * - Survive admin page refresh (via Persistence)
 */

if (typeof window.RelayBlockchainState === 'undefined') {
  class RelayBlockchainState {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.chain = [];
    this.participants = new Map(); // userId -> { userId, role, name, hashrate, blocksMined, balance, joinedAt }
    this.pendingTransactions = [];
    this.settings = {
      difficultyLeading: 3,
      difficultySecondary: 15,
      miningRewardCoins: 10,
      parametersLocked: false,
      networkMode: 'admin-relay'
    };
    this.networkStats = {
      totalHashrate: 0,
      blockHeight: 0,
      lastBlockTime: null,
      totalTransactions: 0,
      averageBlockTimeMs: null,
      blockIntervals: []
    };
    this.allBlocks = new Map(); // hash -> block (for simple fork/orphan handling)
    this.genesisCreated = false;
  }

  // Create a minimal genesis block
  ensureGenesis() {
    if (this.genesisCreated && this.chain.length > 0) return;

    const genesis = {
      index: 0,
      hash: '0000000000000000000000000000000000000000000000000000000000000000',
      previousHash: '0',
      timestamp: Date.now() - 10000,
      nonce: 0,
      transactions: [],
      miner: 'genesis',
      difficulty: this.settings.difficultyLeading,
      data: 'Genesis Block - Blockchain Lab (Client Relay)'
    };

    this.chain = [genesis];
    this.allBlocks.set(genesis.hash, genesis);
    this.genesisCreated = true;
    this.networkStats.blockHeight = 0;
    this.networkStats.lastBlockTime = genesis.timestamp;
  }

  // Update admin settings (called when admin changes sliders)
  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    // Always expose a miner-friendly difficulty object
    const leading = this.settings.difficultyLeading || 3;
    const secondary = this.settings.difficultySecondary !== undefined ? this.settings.difficultySecondary : 15;
    this.settings.currentDifficulty = {
      leadingZeros: leading,
      secondaryHex: Number(secondary).toString(16).toUpperCase()
    };
  }

  calculateDifficulty(leading, secondary) {
    return {
      leadingZeros: leading || 3,
      secondaryHex: Number(secondary !== undefined ? secondary : 15).toString(16).toUpperCase()
    };
  }

  _recordBlockInterval(block) {
    const prev = this.chain.length >= 2 ? this.chain[this.chain.length - 2] : null;
    if (!prev || !block || !block.timestamp || !prev.timestamp) return;
    // Ignore genesis→first interval noise if genesis used a fake older timestamp
    if (prev.index === 0 && prev.miner === 'genesis') {
      // still record first real block interval from "now-ish" genesis for demo value
    }
    const interval = Math.max(0, (block.timestamp || 0) - (prev.timestamp || 0));
    if (!Array.isArray(this.networkStats.blockIntervals)) this.networkStats.blockIntervals = [];
    this.networkStats.blockIntervals.push(interval);
    // Keep last 20 intervals
    if (this.networkStats.blockIntervals.length > 20) {
      this.networkStats.blockIntervals = this.networkStats.blockIntervals.slice(-20);
    }
    const sum = this.networkStats.blockIntervals.reduce((a, b) => a + b, 0);
    this.networkStats.averageBlockTimeMs = sum / this.networkStats.blockIntervals.length;
  }

  // Called when a new peer joins via the relay
  addOrUpdateParticipant(userId, role = 'miner', extra = {}) {
    if (!this.participants.has(userId)) {
      this.participants.set(userId, {
        userId,
        role,
        name: extra.name || null,
        hashrate: 0,
        blocksMined: 0,
        balance: 0,
        joinedAt: Date.now(),
        status: 'idle',
        ...extra
      });
    } else {
      const p = this.participants.get(userId);
      Object.assign(p, extra);
    }
  }

  /**
   * Walk parent links back to genesis. Returns null if the path is incomplete.
   */
  _pathToGenesis(tipHash) {
    if (!tipHash || !this.allBlocks.has(tipHash)) return null;
    const genesisHash = this.chain[0] && this.chain[0].hash;
    const path = [];
    const seen = new Set();
    let cur = this.allBlocks.get(tipHash);

    while (cur) {
      if (seen.has(cur.hash)) return null;
      seen.add(cur.hash);
      path.unshift(cur);

      const isGenesis =
        cur.index === 0 ||
        cur.previousHash === '0' ||
        cur.miner === 'genesis' ||
        (genesisHash && cur.hash === genesisHash);
      if (isGenesis) {
        if (genesisHash && cur.hash !== genesisHash) return null;
        return path;
      }

      cur = this.allBlocks.get(cur.previousHash);
      if (!cur) return null;
    }
    return null;
  }

  /**
   * Longest-chain fork choice. Equal height → keep the current tip (first-seen wins).
   */
  _selectBestChain() {
    let best = this.chain && this.chain.length ? this.chain.slice() : [];

    this.allBlocks.forEach((_block, hash) => {
      const path = this._pathToGenesis(hash);
      if (!path || path.length === 0) return;
      if (path.length > best.length) {
        best = path;
      }
      // Equal length: keep existing tip (stable / first-seen)
    });

    return best;
  }

  _recomputeMiningRewards() {
    const reward = this.settings.miningRewardCoins || 10;
    this.participants.forEach((p) => {
      p.blocksMined = 0;
      p.balance = 0;
    });

    this.chain.forEach((block) => {
      if (!block || !block.miner || block.miner === 'genesis') return;
      const minerId = block.miner;
      if (!this.participants.has(minerId)) {
        this.addOrUpdateParticipant(minerId, 'miner');
      }
      const miner = this.participants.get(minerId);
      miner.blocksMined = (miner.blocksMined || 0) + 1;
      miner.balance = (miner.balance || 0) + reward;
    });
  }

  // Main entry point: a miner submitted a block via the relay
  // Returns { accepted, reason?, newHeight?, isFork?, reorg?, tipChanged?, chain? }
  tryAddBlock(block, fromUserId) {
    if (!block || !block.hash || !block.previousHash) {
      return { accepted: false, reason: 'Malformed block' };
    }

    if (this.allBlocks.has(block.hash)) {
      return {
        accepted: false,
        reason: 'Duplicate block',
        chain: this.chain.slice(),
        newHeight: Math.max(0, this.chain.length - 1)
      };
    }

    // Basic PoW check using current settings
    const leading = (this.settings.difficultyLeading != null) ? this.settings.difficultyLeading : 3;
    const requiredPrefix = leading > 0 ? '0'.repeat(leading) : '';

    if (requiredPrefix && !block.hash.startsWith(requiredPrefix)) {
      return { accepted: false, reason: `Block does not meet difficulty (needs ${leading} leading zeros)` };
    }

    this.ensureGenesis();

    const oldTip = this.chain[this.chain.length - 1] || null;

    if (!this.allBlocks.has(block.previousHash) && block.previousHash !== '0') {
      console.warn('[RelayState] Block parent not yet known — storing as orphan until parent arrives');
    }

    this.allBlocks.set(block.hash, Object.assign({}, block, {
      miner: block.miner || fromUserId || block.miner
    }));

    if (fromUserId && !this.participants.has(fromUserId)) {
      this.addOrUpdateParticipant(fromUserId, 'miner');
    }

    const bestChain = this._selectBestChain();
    const newTip = bestChain[bestChain.length - 1] || null;
    const tipChanged = !!(newTip && (!oldTip || oldTip.hash !== newTip.hash));
    const isDirectExtension = !!(oldTip && newTip && newTip.previousHash === oldTip.hash);
    const didReorg = tipChanged && !isDirectExtension;
    const onBest = bestChain.some((b) => b.hash === block.hash);

    this.chain = bestChain;
    this.networkStats.blockHeight = Math.max(0, this.chain.length - 1);
    if (newTip && (isDirectExtension || (onBest && block.hash === newTip.hash))) {
      this.networkStats.lastBlockTime = newTip.timestamp || Date.now();
      if (isDirectExtension) {
        this._recordBlockInterval(newTip);
      }
    }

    this._recomputeMiningRewards();

    return {
      accepted: true,
      newHeight: Math.max(0, this.chain.length - 1),
      isFork: !onBest,
      reorg: didReorg,
      tipChanged: tipChanged,
      chain: this.chain.slice()
    };
  }
  tryAddTransaction(tx) {
    if (!tx) return { accepted: false, reason: 'Empty transaction' };
    this.pendingTransactions.push(tx);
    this.networkStats.totalTransactions = (this.networkStats.totalTransactions || 0) + 1;
    return { accepted: true };
  }

  // What we send to a newly joined peer
  getSanitizedStateForNewPeer() {
    return {
      chain: this.chain,
      participants: Array.from(this.participants.values()),
      adminSettings: { ...this.settings },
      networkStats: { ...this.networkStats },
      pendingTransactions: this.pendingTransactions.slice(0, 20)
    };
  }

  // Get current state snapshot (for persistence + admin UI)
  getFullState() {
    return {
      roomCode: this.roomCode,
      chain: this.chain,
      allBlocks: Array.from(this.allBlocks.values()),
      participants: Array.from(this.participants.values()),
      settings: { ...this.settings },
      networkStats: { ...this.networkStats },
      pendingTransactions: [...this.pendingTransactions],
      timestamp: Date.now()
    };
  }

  // Restore from persisted data (used on admin refresh)
  restoreFromPersisted(persisted) {
    if (!persisted) return false;

    if (persisted.chain && Array.isArray(persisted.chain) && persisted.chain.length > 0) {
      this.chain = persisted.chain;
      this.genesisCreated = true;
    }
    if (persisted.participants) {
      this.participants = new Map();
      persisted.participants.forEach(p => this.participants.set(p.userId, p));
    }
    if (persisted.settings) this.settings = { ...this.settings, ...persisted.settings };
    if (persisted.networkStats) this.networkStats = { ...this.networkStats, ...persisted.networkStats };
    if (persisted.pendingTransactions) this.pendingTransactions = persisted.pendingTransactions;

    // Rebuild allBlocks: prefer persisted orphans + chain
    this.allBlocks = new Map();
    if (Array.isArray(persisted.allBlocks)) {
      persisted.allBlocks.forEach((b) => {
        if (b && b.hash) this.allBlocks.set(b.hash, b);
      });
    }
    this.chain.forEach((b) => {
      if (b && b.hash) this.allBlocks.set(b.hash, b);
    });

    // Re-run fork choice in case orphans are longer
    this.chain = this._selectBestChain();
    this.networkStats.blockHeight = Math.max(0, this.chain.length - 1);
    this._recomputeMiningRewards();

    return true;
  }

  // Update hashrate for a participant (called from client reports)
  updateHashrate(userId, hashrate) {
    const p = this.participants.get(userId);
    if (p) {
      p.hashrate = hashrate || 0;
      // Recalculate total
      let total = 0;
      this.participants.forEach(pp => total += (pp.hashrate || 0));
      this.networkStats.totalHashrate = total;
    }
  }
}

window.RelayBlockchainState = RelayBlockchainState;
  } // end guard