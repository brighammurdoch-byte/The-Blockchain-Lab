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
    this.participants.set(msg.from, {
      userId: msg.from,
      role: role,
      joinedAt: msg.timestamp
    });

    if (this.lab && typeof this.lab.addOrUpdateParticipant === 'function') {
      this.lab.addOrUpdateParticipant(msg.from, role);
    }

    // Prefer the new RelayBlockchainState API
    let state;
    if (this.lab && typeof this.lab.getSanitizedStateForNewPeer === 'function') {
      state = this.lab.getSanitizedStateForNewPeer();
    } else if (this.lab && typeof this.lab.getSanitizedStateForNetwork === 'function') {
      state = this.lab.getSanitizedStateForNetwork();
    } else {
      state = {};
    }

    this.net.send('initial-state', state, msg.from);
  }

  _handleBlockSubmitted(msg) {
    const block = msg.payload?.block || msg.block;
    const from = msg.from || msg.payload?.minerId;

    let result = { accepted: false };
    if (this.lab && typeof this.lab.tryAddBlock === 'function') {
      result = this.lab.tryAddBlock(block, from) || { accepted: false };
    }

    if (result.accepted) {
      this.net.send('block-accepted', {
        block,
        minerId: from
      });
    } else {
      this.net.send('block-rejected', { reason: result.reason || 'Rejected by hub' }, from);
    }
  }

  _handleTransactionSubmitted(msg) {
    const tx = msg.payload?.transaction || msg.transaction;
    let result = { accepted: false };

    if (this.lab && typeof this.lab.tryAddTransaction === 'function') {
      result = this.lab.tryAddTransaction(tx) || { accepted: false };
    }

    if (result.accepted) {
      this.net.send('transaction-accepted', tx);
    }
  }
}

window.AdminRelayCoordinator = AdminRelayCoordinator;
  } // end guard
