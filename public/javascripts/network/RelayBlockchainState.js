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

  // Main entry point: a miner submitted a block via the relay
  // Returns { accepted: boolean, reason?: string, newHeight?: number }
  tryAddBlock(block, fromUserId) {
    if (!block || !block.hash || !block.previousHash) {
      return { accepted: false, reason: 'Malformed block' };
    }

    // Basic PoW check using current settings
    const leading = this.settings.difficultyLeading || 3;
    const requiredPrefix = '0'.repeat(leading);

    if (!block.hash.startsWith(requiredPrefix)) {
      return { accepted: false, reason: `Block does not meet difficulty (needs ${leading} leading zeros)` };
    }

    // Check it extends current tip or is a reasonable fork
    const currentTip = this.chain[this.chain.length - 1];
    const isExtension = block.previousHash === currentTip.hash;

    if (!isExtension) {
      // Simple fork handling: allow if previousHash exists in our known blocks
      if (!this.allBlocks.has(block.previousHash)) {
        // Could be a deep fork or attack simulation - still accept for education
        console.warn('[RelayState] Block extends unknown parent - treating as fork');
      }
    }

    // Store the block
    this.allBlocks.set(block.hash, block);

    // Append to main chain (for simplicity in v1; real fork choice can be added later)
    if (isExtension || this.chain.length === 0) {
      this.chain.push(block);
      this.networkStats.blockHeight = this.chain.length - 1;
      this.networkStats.lastBlockTime = block.timestamp || Date.now();
      this._recordBlockInterval(block);

      // Reward the miner (educational)
      const miner = this.participants.get(fromUserId);
      if (miner) {
        miner.blocksMined = (miner.blocksMined || 0) + 1;
        miner.balance = (miner.balance || 0) + (this.settings.miningRewardCoins || 10);
      } else if (fromUserId) {
        // Auto-register unknown miner so UI updates even if peer-joined was missed
        this.addOrUpdateParticipant(fromUserId, 'miner', {
          blocksMined: 1,
          balance: this.settings.miningRewardCoins || 10
        });
      }

      return {
        accepted: true,
        newHeight: this.chain.length - 1,
        isFork: false
      };
    } else {
      // Accepted as competing block (orphan/fork) for demo purposes
      return {
        accepted: true,
        newHeight: this.chain.length - 1,
        isFork: true
      };
    }
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

    // Rebuild allBlocks index
    this.allBlocks = new Map();
    this.chain.forEach(b => this.allBlocks.set(b.hash, b));

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