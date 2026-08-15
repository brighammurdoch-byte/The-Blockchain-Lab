/**
 * AdminRelayCoordinator
 *
 * Used when the admin is running in 'admin-relay' mode.
 * The admin browser is responsible for:
 *   - Maintaining canonical blockchain state
 *   - Broadcasting updates to peers
 *   - Handling admin controls (difficulty, attack simulations, etc.)
 *
 * Works together with NetworkManager + Persistence.
 */
if (typeof window.AdminRelayCoordinator === 'undefined') {
  class AdminRelayCoordinator {
  constructor(networkManager, blockchainLabInstance) {
    this.net = networkManager;
    this.lab = blockchainLabInstance; // Can be RelayBlockchainState or legacy adapter
    this.participants = new Map();
    this._saveInterval = null;

    this.net.on('peer-joined', (msg) => this._handlePeerJoined(msg));
    this.net.on('block-submitted', (msg) => this._handleBlockSubmitted(msg));
    this.net.on('transaction-submitted', (msg) => this._handleTransactionSubmitted(msg));
  }

  startAutoSave(intervalMs = 15000) {
    if (this._saveInterval) return;

    this._saveInterval = setInterval(() => {
      if (this.net.isAdmin && this.net.roomCode && this.lab) {
        let state;
        if (typeof this.lab.getFullState === 'function') {
          state = this.lab.getFullState();
        } else if (typeof this.lab.getFullStateForPersistence === 'function') {
          state = this.lab.getFullStateForPersistence();
        } else {
          state = this.lab;
        }
        Persistence.saveAdminState(this.net.roomCode, state);
      }
    }, intervalMs);
  }

  stopAutoSave() {
    if (this._saveInterval) {
      clearInterval(this._saveInterval);
      this._saveInterval = null;
    }
  }

  // Restore state after admin refresh (called by admin page)
  restoreFromPersistence() {
    if (!this.net.isAdmin || !this.net.roomCode) return false;

    const saved = Persistence.loadAdminState(this.net.roomCode);
    if (!saved) return false;

    if (this.lab && typeof this.lab.restoreFromPersisted === 'function') {
      return this.lab.restoreFromPersisted(saved);
    }
    if (this.lab && typeof this.lab.restoreFromPersistedState === 'function') {
      this.lab.restoreFromPersistedState(saved);
      return true;
    }
    return false;
  }

  broadcastSettings(newSettings) {
    this.net.send('admin-settings-updated', newSettings);
  }

  broadcastAttackSimulation(data) {
    this.net.send('attack-simulation', data);
  }

  _handlePeerJoined(msg) {
    const role = msg.role || (msg.payload && msg.payload.role) || 'miner';
    const isProbe = msg.from && String(msg.from).indexOf('probe-') === 0;

    if (!isProbe) {
      this.participants.set(msg.from, {
        userId: msg.from,
        role: role,
        joinedAt: msg.timestamp
      });

      if (this.lab && typeof this.lab.addOrUpdateParticipant === 'function') {
        // Wallets/observers get 100 demo coins so they can transact immediately
        const r = String(role || '').toLowerCase();
        const extra = (r === 'wallet' || r === 'observer') ? { endowment: 100 } : {};
        const nm = (
          msg.name ||
          (msg.payload && (msg.payload.name || msg.payload.displayName)) ||
          ''
        ).trim();
        if (nm) {
          extra.name = nm;
          extra.displayName = nm;
        }
        this.lab.addOrUpdateParticipant(msg.from, role, extra);
        if (typeof this.lab._recomputeMiningRewards === 'function') {
          this.lab._recomputeMiningRewards();
        }
      }
    }

    // Yield so a join toast cannot synchronously serialize the full chain
    // + topology + roster in the same turn (XU1J1S Aw Snap error 9).
    const self = this;
    const to = msg.from;
    setTimeout(function () {
      let state;
      if (self.lab && typeof self.lab.getSanitizedStateForNewPeer === 'function') {
        state = self.lab.getSanitizedStateForNewPeer();
      } else if (self.lab && typeof self.lab.getSanitizedStateForNetwork === 'function') {
        state = self.lab.getSanitizedStateForNetwork();
      } else {
        state = {};
      }

      self.net.send('initial-state', state, to);

      // Tell the room the new wallet's funded balance (so rosters update)
      if (!isProbe && self.lab && self.lab.participants) {
        try {
          self.net.send('participants-roster', {
            participants: Array.from(self.lab.participants.values())
          });
        } catch (e) {}
      }
    }, 0);
  }

  _handleBlockSubmitted(msg) {
    const block = msg.payload?.block || msg.block;
    const from = msg.from || msg.payload?.minerId;
    const incomingName = String(
      (msg.payload && (msg.payload.displayName || msg.payload.name)) ||
      msg.displayName || msg.name || ''
    ).trim();
    if (from && incomingName && this.lab && typeof this.lab.addOrUpdateParticipant === 'function') {
      this.lab.addOrUpdateParticipant(from, 'miner', {
        name: incomingName,
        displayName: incomingName
      });
    }

    if (this.lab && this.lab.networkPaused) {
      this.net.send('block-rejected', {
        reason: 'Network paused by admin',
        blockHash: block && block.hash,
        chain: this.lab && Array.isArray(this.lab.chain) ? this.lab.chain.slice() : null
      }, from);
      return;
    }

    let result = { accepted: false };
    if (this.lab && typeof this.lab.tryAddBlock === 'function') {
      result = this.lab.tryAddBlock(block, from) || { accepted: false };
    }

    if (result.accepted) {
      // Duplicate delivery — already on chain; don't rebroadcast or reject
      if (result.duplicate) return;

      const snap = (this.lab && typeof this.lab.getSanitizedStateForNewPeer === 'function')
        ? this.lab.getSanitizedStateForNewPeer()
        : {};
      const chain = result.chain || snap.chain ||
        (this.lab && Array.isArray(this.lab.chain) ? this.lab.chain.slice() : null);
      const participants = snap.participants ||
        ((this.lab && this.lab.participants instanceof Map)
          ? Array.from(this.lab.participants.values())
          : []);

      // Compact MQTT payloads: full chain only on reorg/orphan — tip extensions send the new block only.
      // Flooding the full chain on every block kills public MQTT brokers in fast classroom demos.
      // During a hard-fork simulation, always include orphans so NEW-side miners can extend their tip.
      const hardForkLive = !!(this.lab && this.lab.pendingFork && this.lab.pendingFork.height != null);
      const needFullChain = !!(result.reorg || result.isFork || !result.tipChanged || hardForkLive);
      const needOrphans = needFullChain || hardForkLive || !!(block && block.forkId && block.forkId !== 'classic');
      const packed = (needFullChain && this.lab && typeof this.lab.compactChainForTransport === 'function')
        ? this.lab.compactChainForTransport(50000)
        : null;
      const tipHash = result.tipHash || snap.tipHash || (this.lab && this.lab.chain && this.lab.chain.length
        ? this.lab.chain[this.lab.chain.length - 1].hash
        : null);
      const tipIndex = result.tipIndex != null ? result.tipIndex : result.newHeight;

      this.net.send('block-accepted', {
        block,
        minerId: from,
        isFork: !!result.isFork,
        reorg: !!result.reorg,
        tipChanged: !!result.tipChanged,
        newHeight: result.newHeight,
        tipHash: tipHash,
        tipIndex: tipIndex,
        chain: packed ? packed.chain : (needFullChain ? chain : undefined),
        chainTruncated: packed ? !!packed.chainTruncated : undefined,
        chainHeight: packed ? packed.chainHeight : result.newHeight,
        orphans: needOrphans ? (snap.orphans || []).slice(-12) : undefined,
        participants: participants,
        pendingTransactions: snap.pendingTransactions || [],
        networkStats: snap.networkStats || (this.lab && this.lab.networkStats ? { ...this.lab.networkStats } : undefined),
        pendingFork: this.lab && this.lab.pendingFork ? this.lab.pendingFork : undefined,
        requeuedTransactions: result.requeuedTransactions || [],
        droppedTransactions: result.droppedTransactions || []
      });

      if (
        typeof this.onMempoolRequeue === 'function' &&
        ((result.requeuedTransactions && result.requeuedTransactions.length) ||
          (result.droppedTransactions && result.droppedTransactions.length))
      ) {
        try { this.onMempoolRequeue(result); } catch (e) {}
      }

      // Auto-difficulty: push new target to miners after a tip extension
      if (result.retargetSettings) {
        this.broadcastSettings(result.retargetSettings);
        if (typeof this.onDifficultyRetarget === 'function') {
          try { this.onDifficultyRetarget(result.retargetSettings); } catch (e) {}
        }
      }
    } else {
      const packed = (this.lab && typeof this.lab.compactChainForTransport === 'function')
        ? this.lab.compactChainForTransport(50000)
        : null;
      const chain = packed
        ? packed.chain
        : (this.lab && Array.isArray(this.lab.chain) ? this.lab.chain.slice() : null);
      const tip = this.lab && this.lab.chain && this.lab.chain.length
        ? this.lab.chain[this.lab.chain.length - 1]
        : null;
      this.net.send('block-rejected', {
        reason: result.reason || 'Rejected by hub',
        blockHash: block && block.hash,
        chain: chain,
        chainTruncated: packed ? !!packed.chainTruncated : undefined,
        chainHeight: packed ? packed.chainHeight : result.newHeight,
        tipHash: result.tipHash || (tip && tip.hash),
        tipIndex: result.tipIndex != null ? result.tipIndex : result.newHeight,
        newHeight: result.newHeight,
        difficultyLeading: result.difficultyLeading,
        difficultySecondary: result.difficultySecondary
      }, from);
      if (this.lab && typeof this.lab.maybeEaseDifficultyIfStalled === 'function') {
        const eased = this.lab.maybeEaseDifficultyIfStalled();
        if (eased) {
          this.broadcastSettings(eased);
          if (typeof this.onDifficultyRetarget === 'function') {
            try { this.onDifficultyRetarget(eased); } catch (e) {}
          }
        }
      }
    }
  }

  _handleTransactionSubmitted(msg) {
    const tx = msg.payload?.transaction || msg.transaction || msg.payload;
    if (this.lab && this.lab.networkPaused) {
      return;
    }
    let result = { accepted: false };

    if (this.lab && typeof this.lab.tryAddTransaction === 'function') {
      result = this.lab.tryAddTransaction(tx) || { accepted: false };
    }

    if (result.accepted) {
      const pending = (this.lab && Array.isArray(this.lab.pendingTransactions))
        ? this.lab.pendingTransactions.slice()
        : [];
      const participants = (this.lab && this.lab.participants instanceof Map)
        ? Array.from(this.lab.participants.values())
        : [];
      this.net.send('transaction-accepted', {
        transaction: result.transaction || tx,
        pendingTransactions: pending,
        participants: participants
      });
    }
  }
}

window.AdminRelayCoordinator = AdminRelayCoordinator;
  } // end guard
