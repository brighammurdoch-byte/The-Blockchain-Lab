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
      // Start easy; auto-difficulty climbs toward targetBlockTimeSec
      difficultyLeading: 1,
      difficultySecondary: 8,
      miningRewardCoins: 10,
      parametersLocked: false,
      networkMode: 'admin-relay',
      /** Desired average seconds between blocks (classroom pacing). */
      targetBlockTimeSec: 10,
      /** When true, hub nudges difficulty after each tip extension. */
      autoDifficulty: true
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
    this.networkPaused = false;
    /** { height, name } when a classroom hard fork is proposed */
    this.pendingFork = null;
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
    if (this.settings.targetBlockTimeSec != null) {
      const t = Number(this.settings.targetBlockTimeSec);
      this.settings.targetBlockTimeSec = isNaN(t) ? 10 : Math.max(2, Math.min(120, t));
    }
    if (this.settings.autoDifficulty != null) {
      this.settings.autoDifficulty = !!this.settings.autoDifficulty;
    }
    // Always expose a miner-friendly difficulty object
    const leading = this.settings.difficultyLeading != null ? this.settings.difficultyLeading : 1;
    const secondary = this.settings.difficultySecondary !== undefined ? this.settings.difficultySecondary : 8;
    this.settings.difficultyLeading = leading;
    this.settings.difficultySecondary = secondary;
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

  /** Encode leading zeros + secondary nibble as a single ladder step. */
  _difficultyScore(leading, secondary) {
    const L = Math.max(1, Math.min(6, Number(leading) || 1));
    const S = Math.max(0, Math.min(15, Number(secondary) || 0));
    return L * 16 + S;
  }

  _scoreToDifficulty(score) {
    const minScore = 1 * 16 + 0;
    const maxScore = 5 * 16 + 15; // leading 6 is usually unusable in class
    const s = Math.max(minScore, Math.min(maxScore, score));
    return {
      difficultyLeading: Math.floor(s / 16),
      difficultySecondary: s % 16
    };
  }

  /**
   * Nudge difficulty so recent block intervals approach targetBlockTimeSec.
   * Returns updated settings object if changed, else null.
   */
  maybeRetargetDifficulty() {
    if (!this.settings || !this.settings.autoDifficulty) return null;
    if (this.settings.parametersLocked) return null;

    const targetSec = Number(this.settings.targetBlockTimeSec);
    const targetMs = Math.max(2000, Math.min(120000, (isNaN(targetSec) ? 10 : targetSec) * 1000));
    const intervals = Array.isArray(this.networkStats.blockIntervals)
      ? this.networkStats.blockIntervals
      : [];
    if (intervals.length < 1) return null;

    // Responsive window: last few blocks
    const recent = intervals.slice(-5);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (!(avg > 0)) return null;

    const ratio = avg / targetMs;
    let delta = 0;
    // Blocks too fast → harder; too slow → easier
    if (ratio < 0.45) delta = 4;
    else if (ratio < 0.65) delta = 2;
    else if (ratio < 0.85) delta = 1;
    else if (ratio > 2.2) delta = -4;
    else if (ratio > 1.55) delta = -2;
    else if (ratio > 1.2) delta = -1;
    // ~0.85–1.2 of target: hold

    if (delta === 0) return null;

    const curScore = this._difficultyScore(
      this.settings.difficultyLeading,
      this.settings.difficultySecondary
    );
    const next = this._scoreToDifficulty(curScore + delta);
    if (
      next.difficultyLeading === this.settings.difficultyLeading &&
      next.difficultySecondary === this.settings.difficultySecondary
    ) {
      return null;
    }

    this.updateSettings(next);
    this.networkStats.lastRetarget = {
      at: Date.now(),
      avgMs: avg,
      targetMs: targetMs,
      ratio: ratio,
      delta: delta,
      leading: next.difficultyLeading,
      secondary: next.difficultySecondary
    };
    return Object.assign({}, this.settings);
  }

  _recordBlockInterval(block) {
    const prev = this.chain.length >= 2 ? this.chain[this.chain.length - 2] : null;
    if (!prev || !block || !block.timestamp || !prev.timestamp) return;
    // Skip genesis→first (genesis timestamp is synthetic and skews the average)
    if (prev.miner === 'genesis' || prev.index === 0) return;

    const interval = Math.max(0, (block.timestamp || 0) - (prev.timestamp || 0));
    if (!(interval > 0)) return;
    if (!Array.isArray(this.networkStats.blockIntervals)) this.networkStats.blockIntervals = [];
    this.networkStats.blockIntervals.push(interval);
    // Keep last 20 intervals
    if (this.networkStats.blockIntervals.length > 20) {
      this.networkStats.blockIntervals = this.networkStats.blockIntervals.slice(-20);
    }
    const sum = this.networkStats.blockIntervals.reduce((a, b) => a + b, 0);
    this.networkStats.averageBlockTimeMs = sum / this.networkStats.blockIntervals.length;
  }

  /**
   * Classroom starting coins (applied after each chain recompute via p.endowment).
   * Admin hub and student wallets get 100 so demos work without mining first.
   */
  static defaultEndowmentForRole(role) {
    const r = String(role || '').toLowerCase();
    if (r === 'wallet' || r === 'observer' || r === 'admin' || r === 'hub') return 100;
    return 0;
  }

  // Called when a new peer joins via the relay
  addOrUpdateParticipant(userId, role = 'miner', extra = {}) {
    extra = extra || {};
    if (!this.participants.has(userId)) {
      const endow = (extra.endowment != null)
        ? Math.max(0, Number(extra.endowment) || 0)
        : RelayBlockchainState.defaultEndowmentForRole(role);
      const row = {
        userId: userId,
        role: role,
        name: extra.name || null,
        hashrate: 0,
        blocksMined: 0,
        balance: endow,
        endowment: endow,
        joinedAt: Date.now(),
        status: 'idle'
      };
      Object.assign(row, extra);
      // Keep endowment authoritative after assign
      row.endowment = (extra.endowment != null)
        ? Math.max(0, Number(extra.endowment) || 0)
        : endow;
      if (extra.balance == null) row.balance = row.endowment;
      this.participants.set(userId, row);
    } else {
      const p = this.participants.get(userId);
      Object.assign(p, extra);
      // Promote a known peer to wallet with starting coins if they never had an endowment
      const r = String(role || p.role || '').toLowerCase();
      if (
        (r === 'wallet' || r === 'observer') &&
        !(Number(p.endowment) > 0) &&
        extra.endowment == null
      ) {
        p.endowment = 100;
        p.role = role || p.role || 'wallet';
        p.balance = (Number(p.balance) || 0) + 100;
      } else if (role && !p.role) {
        p.role = role;
      }
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
   * True if path is valid as the classroom "main" (classic) chain during a hard fork.
   * After activation height, main must not include NEW-tagged blocks — those stay as
   * permanent orphans so the demo shows two parallel chains instead of a reorg.
   */
  _isClassicMainPath(path) {
    if (!path || !path.length) return false;
    if (!this.pendingFork || this.pendingFork.height == null) return true;
    const act = Number(this.pendingFork.height);
    for (let i = 0; i < path.length; i++) {
      const b = path[i];
      if (!b || b.index == null) continue;
      if (Number(b.index) < act) continue;
      const fid = b.forkId || 'classic';
      if (fid === 'new' || fid === 'NEW') return false;
    }
    return true;
  }

  /**
   * Longest-chain fork choice. Equal height → keep the current tip (first-seen wins).
   *
   * During a hard-fork simulation, main is restricted to classic-compatible paths so
   * the NEW side never "wins" via pure length and erases the permanent split.
   */
  _selectBestChain() {
    const hardFork = !!(this.pendingFork && this.pendingFork.height != null);
    let best = [];

    // Seed with current chain only if it still qualifies (don't lock onto a NEW tip)
    if (this.chain && this.chain.length) {
      if (!hardFork || this._isClassicMainPath(this.chain)) {
        best = this.chain.slice();
      }
    }

    this.allBlocks.forEach((_block, hash) => {
      const path = this._pathToGenesis(hash);
      if (!path || path.length === 0) return;
      if (hardFork && !this._isClassicMainPath(path)) return;
      if (path.length > best.length) {
        best = path;
      }
      // Equal length: keep existing tip (stable / first-seen)
    });

    // Fallback if hard-fork filter left us empty (e.g. only NEW blocks exist yet)
    if (!best.length) {
      this.allBlocks.forEach((_block, hash) => {
        const path = this._pathToGenesis(hash);
        if (!path || path.length === 0) return;
        if (path.length > best.length) best = path;
      });
    }

    return best;
  }

  /** Stable id for a transfer (used for mempool + double-include checks). */
  _txKey(tx) {
    if (!tx) return '';
    if (tx.id) return String(tx.id);
    return String(tx.from || '') + ':' + String(tx.to || '') + ':' + String(tx.timestamp || '');
  }

  /** All transaction keys already present on the current canonical chain. */
  _confirmedTxIds() {
    const ids = new Set();
    (this.chain || []).forEach((block) => {
      const txs = (block && Array.isArray(block.transactions)) ? block.transactions : [];
      txs.forEach((tx) => {
        const k = this._txKey(tx);
        if (k) ids.add(k);
      });
    });
    return ids;
  }

  /**
   * Confirmed tx keys relevant to validating `block`.
   * Same-side only after hard-fork activation so the two chains stay independent.
   */
  _confirmedTxIdsForBlock(block) {
    const act =
      this.pendingFork && this.pendingFork.height != null
        ? Number(this.pendingFork.height)
        : null;
    const fid = (block && block.forkId) || 'classic';
    const isNew = fid === 'new' || fid === 'NEW';
    const bIndex = block && block.index != null ? Number(block.index) : null;

    // Pre-fork or no fork: whole canonical chain
    if (act == null || bIndex == null || bIndex < act) {
      return this._confirmedTxIds();
    }

    const ids = new Set();
    // Shared history below activation is common to both sides
    (this.chain || []).forEach((b) => {
      if (!b) return;
      if (b.index != null && Number(b.index) >= act) return; // skip post-act main (classic)
      const txs = Array.isArray(b.transactions) ? b.transactions : [];
      txs.forEach((tx) => {
        const k = this._txKey(tx);
        if (k) ids.add(k);
      });
    });

    // Same-side post-activation blocks only
    this.allBlocks.forEach((b) => {
      if (!b || b.index == null || Number(b.index) < act) return;
      const bf = b.forkId || 'classic';
      const bNew = bf === 'new' || bf === 'NEW';
      if (bNew !== isNew) return;
      const txs = Array.isArray(b.transactions) ? b.transactions : [];
      txs.forEach((tx) => {
        const k = this._txKey(tx);
        if (k) ids.add(k);
      });
    });
    return ids;
  }

  /**
   * Recompute balances from the canonical chain:
   * mining rewards + all included transfers.
   */
  _recomputeMiningRewards() {
    const reward = Number(this.settings.miningRewardCoins) || 10;
    this.participants.forEach((p) => {
      p.blocksMined = 0;
      p.balance = 0;
    });

    const seenTx = new Set();
    this.chain.forEach((block) => {
      if (!block) return;

      if (block.miner && block.miner !== 'genesis') {
        const minerId = block.miner;
        if (!this.participants.has(minerId)) {
          this.addOrUpdateParticipant(minerId, 'miner');
        }
        const miner = this.participants.get(minerId);
        miner.blocksMined = (miner.blocksMined || 0) + 1;
        miner.balance = (miner.balance || 0) + reward;
      }

      const txs = Array.isArray(block.transactions) ? block.transactions : [];
      txs.forEach((tx) => {
        if (!tx) return;
        const from = tx.from;
        const to = tx.to;
        const amount = Number(tx.amount);
        if (!from || !to || !(amount > 0)) return;
        const id = tx.id || (String(from) + ':' + String(to) + ':' + String(tx.timestamp));
        // Same tx can race into two blocks before mempool clears — credit once
        if (seenTx.has(id)) return;
        seenTx.add(id);

        if (!this.participants.has(from)) {
          this.addOrUpdateParticipant(from, 'wallet');
        }
        if (!this.participants.has(to)) {
          this.addOrUpdateParticipant(to, 'wallet');
        }
        const sender = this.participants.get(from);
        const recipient = this.participants.get(to);
        sender.balance = (sender.balance || 0) - amount;
        recipient.balance = (recipient.balance || 0) + amount;
      });
    });

    // Classroom demo: admin + wallets carry a starting endowment (default 100)
    // so students can send coins without mining first. Applied after chain replay.
    this.participants.forEach((p) => {
      let endow = Number(p.endowment) || 0;
      // Backfill wallets that joined before endowment existed
      if (!endow) {
        const r = String(p.role || '').toLowerCase();
        if (r === 'wallet' || r === 'observer' || r === 'admin' || r === 'hub') {
          endow = 100;
          p.endowment = 100;
        }
      }
      if (endow > 0) {
        p.balance = (p.balance || 0) + endow;
      }
    });
  }

  // Main entry point: a miner submitted a block via the relay
  // Returns { accepted, reason?, newHeight?, isFork?, reorg?, tipChanged?, chain? }
  tryAddBlock(block, fromUserId) {
    if (!block || !block.hash || !block.previousHash) {
      return { accepted: false, reason: 'Malformed block' };
    }

    // Idempotent: MQTT/BroadcastChannel can deliver the same block twice.
    // Treat as a quiet success so miners don't get "Block rejected: Duplicate block" toasts.
    if (this.allBlocks.has(block.hash)) {
      const tip = this.chain[this.chain.length - 1] || null;
      return {
        accepted: true,
        duplicate: true,
        tipChanged: false,
        isFork: !(tip && tip.hash === block.hash) && !this.chain.some((b) => b.hash === block.hash),
        reorg: false,
        newHeight: Math.max(0, this.chain.length - 1),
        chain: this.chain.slice()
      };
    }

    // PoW check: leading zeros + secondary hex nibble (matches miner isValidHash)
    const leading = (this.settings.difficultyLeading != null) ? this.settings.difficultyLeading : 1;
    const secondary = (this.settings.difficultySecondary != null) ? this.settings.difficultySecondary : 8;
    const requiredPrefix = leading > 0 ? '0'.repeat(leading) : '';

    if (requiredPrefix && !String(block.hash).startsWith(requiredPrefix)) {
      return { accepted: false, reason: `Block does not meet difficulty (needs ${leading} leading zeros)` };
    }
    if (requiredPrefix) {
      const nextChar = String(block.hash).charAt(leading);
      const secHex = Number(secondary).toString(16).toLowerCase();
      if (nextChar && nextChar.toLowerCase() > secHex) {
        return {
          accepted: false,
          reason: `Block does not meet secondary difficulty (need ≤0x${secHex.toUpperCase()} after ${leading} zeros)`
        };
      }
    }

    this.ensureGenesis();

    // Hard-fork rules: keep classic and NEW sides from crossing after activation
    if (this.pendingFork && this.pendingFork.height != null) {
      const act = Number(this.pendingFork.height);
      const fid = block.forkId || 'classic';
      const isNew = fid === 'new' || fid === 'NEW';
      const parent = this.allBlocks.get(block.previousHash) ||
        (this.chain && this.chain.find(function (b) { return b && b.hash === block.previousHash; }));
      const parentFid = parent ? (parent.forkId || 'classic') : 'classic';
      const parentIsNew = parentFid === 'new' || parentFid === 'NEW';
      const bIndex = block.index != null ? Number(block.index) : null;

      if (bIndex != null && bIndex < act) {
        // Pre-activation: reject NEW-tagged blocks (they cause orphan spam)
        if (isNew) {
          return {
            accepted: false,
            reason: 'Hard fork not active yet (activation at #' + act + ')',
            chain: this.chain.slice(),
            newHeight: Math.max(0, this.chain.length - 1)
          };
        }
      } else if (bIndex != null && bIndex >= act) {
        if (isNew) {
          // NEW must extend another NEW tip, or the classic activation parent (index act-1)
          if (parent) {
            const okFromNew = parentIsNew;
            const okFirst = !parentIsNew && parent.index === act - 1 && bIndex === act;
            if (!okFromNew && !okFirst) {
              return {
                accepted: false,
                reason: 'NEW fork must extend activation parent (#' + (act - 1) + ') or a NEW tip',
                chain: this.chain.slice(),
                newHeight: Math.max(0, this.chain.length - 1)
              };
            }
          }
        } else {
          // Classic post-activation cannot build on NEW blocks
          if (parentIsNew) {
            return {
              accepted: false,
              reason: 'Classic chain cannot extend a NEW-fork block',
              chain: this.chain.slice(),
              newHeight: Math.max(0, this.chain.length - 1)
            };
          }
        }
      }
    }

    // Reject blocks that re-include transfers already confirmed on the *same fork side*.
    // During a hard fork, classic and NEW are permanent parallel histories — a transfer
    // on classic must not block the same transfer on NEW (and vice versa).
    const confirmed = this._confirmedTxIdsForBlock(block);
    const blockTxs = Array.isArray(block.transactions) ? block.transactions : [];
    const seenInBlock = new Set();
    for (let i = 0; i < blockTxs.length; i++) {
      const k = this._txKey(blockTxs[i]);
      if (!k) continue;
      if (confirmed.has(k)) {
        return {
          accepted: false,
          reason: 'Duplicate transaction already on chain',
          chain: this.chain.slice(),
          newHeight: Math.max(0, this.chain.length - 1)
        };
      }
      if (seenInBlock.has(k)) {
        return {
          accepted: false,
          reason: 'Duplicate transaction within block',
          chain: this.chain.slice(),
          newHeight: Math.max(0, this.chain.length - 1)
        };
      }
      seenInBlock.add(k);
    }

    const oldTip = this.chain[this.chain.length - 1] || null;

    if (!this.allBlocks.has(block.previousHash) && block.previousHash !== '0') {
      console.warn('[RelayState] Block parent not yet known — storing as orphan until parent arrives');
    }

    // Sleeping phones keep hashing a stale parent. Accepting those as orphans
    // floods the projector and the phone never follows the real tip.
    // Same-height races and short classroom 51% forks (default 2 back) still pass.
    if (
      oldTip &&
      block.previousHash !== '0' &&
      block.previousHash !== oldTip.hash &&
      !(this.pendingFork && this.pendingFork.height != null)
    ) {
      const parent = this.allBlocks.get(block.previousHash) ||
        (this.chain && this.chain.find(function (b) { return b && b.hash === block.previousHash; }));
      if (parent) {
        const parentIndex = parent.index != null ? Number(parent.index) : -1;
        const tipIndex = oldTip.index != null ? Number(oldTip.index) : Math.max(0, this.chain.length - 1);
        if (parentIndex >= 0 && tipIndex - parentIndex > 4) {
          return {
            accepted: false,
            reason: 'Stale parent — mine on the current hub tip',
            chain: this.chain.slice(),
            newHeight: tipIndex,
            tipHash: oldTip.hash,
            tipIndex: tipIndex
          };
        }
      }
    }

    // First-seen wins at a given parent + height + fork. Extra hashes at the
    // same slot are stale (one miner remine-spam, or a late racer).
    const slotFid = block.forkId || 'classic';
    const slotIndex = block.index != null ? Number(block.index) : null;
    if (slotIndex != null) {
      let sibling = null;
      this.allBlocks.forEach((existing) => {
        if (sibling || !existing) return;
        if (existing.hash === block.hash) return;
        if (String(existing.previousHash) !== String(block.previousHash)) return;
        if (Number(existing.index) !== slotIndex) return;
        if ((existing.forkId || 'classic') !== slotFid) return;
        sibling = existing;
      });
      if (sibling) {
        return {
          accepted: false,
          reason: 'Stale block — already have #' + slotIndex + ' on this parent',
          chain: this.chain.slice(),
          newHeight: Math.max(0, this.chain.length - 1)
        };
      }
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

    // Drop confirmed mempool txs whenever the canonical tip moves
    if (onBest) {
      if (typeof this.clearIncludedTransactions === 'function') {
        this.clearIncludedTransactions(block);
      }
      if (typeof this.purgeConfirmedFromMempool === 'function') {
        this.purgeConfirmedFromMempool();
      }
    }

    // Classroom pacing: retarget difficulty toward target block time
    let retargetSettings = null;
    if (onBest && tipChanged && typeof this.maybeRetargetDifficulty === 'function') {
      retargetSettings = this.maybeRetargetDifficulty();
    }

    const tipOut = this.chain[this.chain.length - 1] || newTip;
    return {
      accepted: true,
      newHeight: Math.max(0, this.chain.length - 1),
      isFork: !onBest,
      reorg: didReorg,
      tipChanged: tipChanged,
      chain: this.chain.slice(),
      tipHash: tipOut && tipOut.hash,
      tipIndex: tipOut && tipOut.index != null ? tipOut.index : Math.max(0, this.chain.length - 1),
      retargetSettings: retargetSettings
    };
  }

  compactChainForTransport(maxBytes) {
    maxBytes = maxBytes || 70000;
    const chain = Array.isArray(this.chain) ? this.chain : [];
    const tip = chain.length ? chain[chain.length - 1] : null;
    const meta = {
      chainHeight: tip && tip.index != null ? tip.index : Math.max(0, chain.length - 1),
      tipHash: tip && tip.hash,
      tipIndex: tip && tip.index != null ? tip.index : Math.max(0, chain.length - 1)
    };
    let size = 0;
    try { size = JSON.stringify(chain).length; } catch (e) { size = 999999; }
    if (size <= maxBytes) return Object.assign({ chain: chain, chainTruncated: false }, meta);
    return Object.assign({ chain: chain.slice(-20), chainTruncated: true }, meta);
  }
  tryAddTransaction(tx) {
    if (!tx) return { accepted: false, reason: 'Empty transaction' };
    // Normalize shape
    const normalized = {
      from: tx.from,
      to: tx.to,
      amount: Number(tx.amount),
      timestamp: tx.timestamp || Date.now(),
      id: tx.id || (String(tx.from || '') + ':' + String(tx.to || '') + ':' + String(tx.timestamp || Date.now()))
    };
    if (!normalized.from || !normalized.to || !(normalized.amount > 0)) {
      return { accepted: false, reason: 'Invalid transaction' };
    }
    // Already confirmed on chain — never re-enter mempool
    if (this._confirmedTxIds().has(String(normalized.id))) {
      return { accepted: false, reason: 'Transaction already confirmed' };
    }
    // Dedupe in mempool
    if (this.pendingTransactions.some((t) => this._txKey(t) === String(normalized.id))) {
      return { accepted: true, duplicate: true };
    }
    this.pendingTransactions.push(normalized);
    this.networkStats.totalTransactions = (this.networkStats.totalTransactions || 0) + 1;
    return { accepted: true, transaction: normalized };
  }

  /** Remove mempool txs that were included in a newly accepted block */
  clearIncludedTransactions(block) {
    if (!block || !Array.isArray(block.transactions) || block.transactions.length === 0) {
      return;
    }
    const keys = new Set(
      block.transactions.map((t) => this._txKey(t)).filter(Boolean)
    );
    this.pendingTransactions = this.pendingTransactions.filter((t) => !keys.has(this._txKey(t)));
  }

  /** Drop any mempool entry that already appears anywhere on the canonical chain. */
  purgeConfirmedFromMempool() {
    const confirmed = this._confirmedTxIds();
    if (!confirmed.size) return;
    this.pendingTransactions = this.pendingTransactions.filter((t) => !confirmed.has(this._txKey(t)));
  }

  // What we send to a newly joined peer
  getSanitizedStateForNewPeer() {
    const mainHashes = new Set(this.chain.map((b) => b.hash));
    const orphans = [];
    this.allBlocks.forEach((block, hash) => {
      if (hash && !mainHashes.has(hash) && block && block.miner !== 'genesis') {
        orphans.push(block);
      }
    });
    const compact = (typeof this.compactChainForTransport === 'function')
      ? this.compactChainForTransport(70000)
      : { chain: this.chain, chainTruncated: false };
    const tip = this.chain.length ? this.chain[this.chain.length - 1] : null;
    return {
      chain: compact.chain,
      chainTruncated: !!compact.chainTruncated,
      chainHeight: compact.chainHeight != null
        ? compact.chainHeight
        : (tip && tip.index != null ? tip.index : Math.max(0, this.chain.length - 1)),
      tipHash: compact.tipHash || (tip && tip.hash),
      tipIndex: compact.tipIndex,
      genesis: compact.chainTruncated ? (this.chain[0] || null) : undefined,
      orphans: compact.chainTruncated ? orphans.slice(-6) : orphans,
      participants: Array.from(this.participants.values()),
      adminSettings: { ...this.settings },
      networkStats: { ...this.networkStats },
      pendingTransactions: this.pendingTransactions.slice(0, 20),
      networkPaused: !!this.networkPaused,
      pendingFork: this.pendingFork ? { ...this.pendingFork } : null
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
      networkPaused: !!this.networkPaused,
      pendingFork: this.pendingFork ? { ...this.pendingFork } : null,
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
    if (typeof persisted.networkPaused === 'boolean') this.networkPaused = persisted.networkPaused;
    if (persisted.pendingFork) this.pendingFork = persisted.pendingFork;

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
      p.lastActivityAt = Date.now();
      const role = String(p.role || 'miner').toLowerCase();
      if (role === 'admin' || role === 'hub') {
        p.status = 'idle';
      } else if (role === 'wallet' || role === 'observer') {
        // Wallets stay idle unless a short-lived viz flash overrides
        if (p.status !== 'receiving' && p.status !== 'sending') p.status = 'idle';
      } else {
        p.status = (p.hashrate > 0) ? 'mining' : 'idle';
      }
      // Recalculate total
      let total = 0;
      this.participants.forEach(pp => total += (pp.hashrate || 0));
      this.networkStats.totalHashrate = total;
    }
  }

  setParticipantStatus(userId, status) {
    const p = this.participants.get(userId);
    if (p) {
      p.status = status || 'idle';
      p.lastActivityAt = Date.now();
    }
  }
}

window.RelayBlockchainState = RelayBlockchainState;
  } // end guard