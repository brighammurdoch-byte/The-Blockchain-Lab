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
  }
};

window.Persistence = Persistence;
} // end guard
