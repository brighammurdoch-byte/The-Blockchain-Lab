/**
 * Simple persistence helpers for Blockchain Lab (client-side).
 *
 * Used to help the admin survive page refreshes in admin-relay mode.
 */

if (typeof window.Persistence === 'undefined') {
const Persistence = {
  saveAdminState(roomCode, state) {
    try {
      this.setLocalItem(`blockchain-lab-admin-${roomCode}`, JSON.stringify(state), roomCode);
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
   * Origin-scoped leftover keys from prior classrooms. Admin-state blobs
   * (blockchain-lab-admin-CODE) are the usual quota fillers on Pages.
   * sessionStorage labAdminLiveHub_* / labAdminFreshCreate_* are never
   * touched — those are this-tab hub flags, not origin leftovers.
   */
  classroomLocalPrefixes: [
    'blockchain-lab-admin-',
    'joinCode_',
    'isAdmin_',
    'networkingMode_',
    'chainFlavor_',
    'adminUserId_',
    'userRole_',
    'userId_',
    'nodeName_',
    'labValidatorCode_'
  ],

  isClassroomSessionCode(code) {
    var s = String(code || '').toUpperCase();
    return /^[A-Z0-9]{4,8}$/.test(s) && !/^(ADMIN|INDEX|LAB)$/.test(s);
  },

  classroomCodeFromKey(key) {
    var k = String(key || '');
    var prefixes = this.classroomLocalPrefixes;
    for (var i = 0; i < prefixes.length; i++) {
      if (k.indexOf(prefixes[i]) !== 0) continue;
      var rest = k.slice(prefixes[i].length);
      var code = rest.split('_')[0];
      if (this.isClassroomSessionCode(code)) return code.toUpperCase();
    }
    return '';
  },

  /**
   * Drop leftover classroom localStorage for every code except keepCode.
   * Never localStorage.clear(). Never delete the room being created.
   * Returns the removed key names.
   */
  pruneLeftoverClassroomKeys(keepCode) {
    var keep = String(keepCode || '').toUpperCase();
    var removed = [];
    try {
      if (typeof localStorage === 'undefined') return removed;
      var toRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        var code = this.classroomCodeFromKey(k);
        if (!code) continue;
        if (keep && code === keep) continue;
        toRemove.push(k);
      }
      for (var j = 0; j < toRemove.length; j++) {
        try {
          localStorage.removeItem(toRemove[j]);
          removed.push(toRemove[j]);
        } catch (eRm) {}
      }
    } catch (e) {}
    return removed;
  },

  /**
   * setItem, or on any failure prune leftover classroom keys (not keepCode)
   * and retry once. Used by Create Session so a full Pages origin can
   * still mint a new room.
   */
  setLocalItem(key, value, keepCode) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      this.pruneLeftoverClassroomKeys(keepCode);
      localStorage.setItem(key, value);
      return true;
    }
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
