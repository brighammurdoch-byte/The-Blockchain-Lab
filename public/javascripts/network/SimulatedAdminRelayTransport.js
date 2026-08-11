/**
 * SimulatedAdminRelayTransport
 *
 * In this mode, the admin's browser acts as the central hub.
 * All other nodes send messages to the admin, and the admin broadcasts to everyone.
 *
 * This works reliably even on heavily restricted school networks because:
 * - Only the admin needs to be "reachable" (they started the session).
 * - Students connect outbound to the admin.
 *
 * For now this uses BroadcastChannel (great for local testing + same-network devices).
 * In the future this can be upgraded to use p2pt with the admin as a well-known peer.
 */

if (typeof window.SimulatedAdminRelayTransport === 'undefined') {
class SimulatedAdminRelayTransport {
  constructor() {
    this.channel = null;
    this.roomCode = null;
    this.userId = null;
    this.isAdmin = false;
    this.onMessage = null;
    this.peers = new Set(); // Only meaningful for admin
  }

  async initAsAdmin(roomCode, userId) {
    this.isAdmin = true;
    this.roomCode = roomCode;
    this.userId = userId;

    const channelName = `blockchain-lab-relay-${roomCode}`;
    this.channel = new BroadcastChannel(channelName);

    this.channel.onmessage = (event) => {
      const msg = event.data;
      if (msg.roomCode !== this.roomCode) return;

      // Track peers
      if (msg.from && !this.peers.has(msg.from)) {
        this.peers.add(msg.from);
      }

      if (this.onMessage) {
        this.onMessage(msg);
      }

      // Admin rebroadcasts messages from others to the whole room
      if (msg.from !== this.userId) {
        this._rebroadcast(msg);
      }
    };

    console.log(`[AdminRelay] Admin started relay room: ${roomCode}`);
  }

  async joinRoom(roomCode, userId, role) {
    this.isAdmin = false;
    this.roomCode = roomCode;
    this.userId = userId;

    const channelName = `blockchain-lab-relay-${roomCode}`;
    this.channel = new BroadcastChannel(channelName);

    this.channel.onmessage = (event) => {
      const msg = event.data;
      if (msg.roomCode !== this.roomCode) return;
      if (this.onMessage) this.onMessage(msg);
    };

    // Announce ourselves to the admin
    this.send({
      type: 'peer-joined',
      roomCode,
      from: userId,
      role,
      timestamp: Date.now()
    });

    console.log(`[AdminRelay] Joined relay room: ${roomCode} as ${userId}`);
  }

  send(message) {
    if (!this.channel) return;
    this.channel.postMessage(message);
  }

  _rebroadcast(message) {
    if (this.channel) {
      const relayed = { ...message, relayedByAdmin: true };
      this.channel.postMessage(relayed);
    }
  }

  disconnect() {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }
}

window.SimulatedAdminRelayTransport = SimulatedAdminRelayTransport;
  } // end if (typeof window.SimulatedAdminRelayTransport === 'undefined')
