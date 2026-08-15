/**
 * Simple persistence helpers for Blockchain Lab (client-side).
 *
 * Used to help the admin survive page refreshes in admin-relay mode.
 */

if (typeof window.Persistence === 'undefined') {
const Persistence = {
  saveAdminState(roomCode, state) {
    try {
      localStorage.setItem(`blockchain-lab-admin-${roomCode}`, JSON.stringify(state));
    } catch (e) {
      console.warn('Failed to save admin state to localStorage', e);
    }
  },

  loadAdminState(roomCode) {
    try {
      const raw = localStorage.getItem(`blockchain-lab-admin-${roomCode}`);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn('Failed to load admin state from localStorage', e);
      return null;
    }
  },

  clearAdminState(roomCode) {
    try {
      localStorage.removeItem(`blockchain-lab-admin-${roomCode}`);
    } catch (e) {}
  },

  /** Landing Create Session: this code must start empty, never restore leftovers. */
  markFreshAdminCreate(roomCode) {
    const code = String(roomCode || '').toUpperCase();
    if (!code) return;
    try { sessionStorage.setItem('labAdminFreshCreate_' + code, '1'); } catch (e) {}
    this.clearAdminState(code);
  },

  consumeFreshAdminCreate(roomCode) {
    const code = String(roomCode || '').toUpperCase();
    if (!code) return false;
    try {
      const fresh = sessionStorage.getItem('labAdminFreshCreate_' + code);
      if (fresh) {
        sessionStorage.removeItem('labAdminFreshCreate_' + code);
        return true;
      }
    } catch (e) {}
    return false;
  },

  /** Restore only on refresh of a tab that already hosted this room — never a new Create. */
  shouldRestoreAdminState(roomCode) {
    const code = String(roomCode || '').toUpperCase();
    if (!code) return false;
    try {
      if (sessionStorage.getItem('labAdminFreshCreate_' + code)) return false;
    } catch (e) {}
    return true;
  },

  liveHubKey(roomCode) {
    return 'labAdminLiveHub_' + String(roomCode || '').toUpperCase();
  },

  /** This tab created or is hosting the room (survives reload, dies on close). */
  markLiveAdminHub(roomCode) {
    const code = String(roomCode || '').toUpperCase();
    if (!code) return;
    try { sessionStorage.setItem(this.liveHubKey(code), '1'); } catch (e) {}
  },

  isLiveAdminHub(roomCode) {
    const code = String(roomCode || '').toUpperCase();
    if (!code) return false;
    try { return sessionStorage.getItem(this.liveHubKey(code)) === '1'; } catch (e) { return false; }
  },

  /**
   * Restore toast only after the tab was closed and Persistence reloads
   * a previous chain. Create, live-hub reload, MQTT reconnect, and
   * in-tab autosave must never toast (XU1J1S mid-watch false restore).
   */
  shouldToastAdminRestore(roomCode, opts) {
    opts = opts || {};
    if (opts.freshCreate) return false;
    if (opts.alreadyToasted) return false;
    if (opts.inMemoryLive) return false;
    const live = (opts.liveHubTab != null)
      ? !!opts.liveHubTab
      : this.isLiveAdminHub(roomCode);
    if (live) return false;
    if (!opts.hasPersistedChain) return false;
    return true;
  }
};

window.Persistence = Persistence;
} // end guard
