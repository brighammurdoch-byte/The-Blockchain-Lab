/**
 * NetworkManager
 *
 * Unified client-side networking for Blockchain Lab.
 *
 * Modes:
 *   'simulated'   → BroadcastChannel only (same-browser multi-tab testing)
 *   'admin-relay' → MQTT classroom hub (+ BroadcastChannel) — default, works on phones
 *   'p2p'         → WebRTC full mesh gossip — teachable decentralized mode
 */

if (typeof window.NetworkManager === 'undefined') {
class NetworkManager {
  constructor(mode = 'admin-relay') {
    this.mode = mode;
    this.roomCode = null;
    this.isAdmin = false;
    this.userId = null;
    this.role = null;

    this.transport = null;
    this.eventHandlers = new Map();
    this.peerCount = 0;

    this._initTransport();
  }

  _initTransport() {
    if (this.mode === 'simulated') {
      if (typeof SimulatedAdminRelayTransport === 'undefined') {
        throw new Error('SimulatedAdminRelayTransport not loaded');
      }
      this.transport = new SimulatedAdminRelayTransport();
    } else if (this.mode === 'p2p') {
      if (typeof P2PAdminRelayTransport === 'undefined') {
        console.warn('P2P transport missing; falling back to MQTT/BroadcastChannel');
        this.transport = typeof MqttAdminRelayTransport !== 'undefined'
          ? new MqttAdminRelayTransport()
          : new SimulatedAdminRelayTransport();
        this.mode = 'admin-relay';
      } else {
        this.transport = new P2PAdminRelayTransport({ routingMode: 'mesh' });
      }
    } else {
      // admin-relay (default): MQTT for reliable phone ↔ instructor joins
      if (typeof MqttAdminRelayTransport !== 'undefined') {
        this.transport = new MqttAdminRelayTransport();
      } else if (typeof P2PAdminRelayTransport !== 'undefined') {
        console.warn('MQTT transport missing; using WebRTC admin-relay (mobile may fail)');
        this.transport = new P2PAdminRelayTransport({ routingMode: 'hub' });
      } else if (typeof SimulatedAdminRelayTransport !== 'undefined') {
        console.warn('Using BroadcastChannel-only admin-relay');
        this.transport = new SimulatedAdminRelayTransport();
      } else {
        throw new Error('No networking transport available');
      }
    }

    var self = this;
    this.transport.onMessage = function (msg) {
      if (!msg) return;
      if (msg.to && self.userId && msg.to !== self.userId && !self.isAdmin) return;
      var msgRoom = msg.roomCode ? String(msg.roomCode).toUpperCase() : '';
      var myRoom = self.roomCode ? String(self.roomCode).toUpperCase() : '';
      if (msgRoom && myRoom && msgRoom !== myRoom) return;
      self._emit(msg.type, msg);
    };

    this.transport.onReconnect = function () {
      self._emit('transport-reconnected', {
        roomCode: self.roomCode,
        userId: self.userId
      });
    };

    this.transport.onDisconnect = function () {
      self._emit('transport-disconnected', {
        roomCode: self.roomCode
      });
    };

    if (typeof this.transport.onPeerCountChange !== 'undefined') {
      this.transport.onPeerCountChange = function (count) {
        self.peerCount = count;
        self._emit('peer-count', { count: count });
      };
    }
  }

  setRoutingMode(mode) {
    var routing = mode === 'p2p' || mode === 'mesh' ? 'mesh' : 'hub';
    this.mode = routing === 'mesh' ? 'p2p' : 'admin-relay';
    if (this.transport && typeof this.transport.setRoutingMode === 'function') {
      this.transport.setRoutingMode(routing);
    }
  }

  async createRoom() {
    this.isAdmin = true;
    this.role = 'admin';
    this.userId = 'admin-' + Date.now().toString(36);
    this.roomCode = this._generateRoomCode();

    await this.transport.initAsAdmin(this.roomCode, this.userId);

    this._emit('room-created', {
      roomCode: this.roomCode,
      isAdmin: true,
      userId: this.userId
    });

    return this.roomCode;
  }

  async joinRoom(roomCode, userId, role) {
    role = role || 'miner';
    this.roomCode = String(roomCode || '').toUpperCase();
    this.userId = userId;
    this.role = role;
    this.isAdmin = (role === 'admin');

    await this.transport.joinRoom(this.roomCode, userId, role);

    this._emit('joined-room', {
      roomCode: roomCode,
      userId: userId,
      role: role,
      isAdmin: this.isAdmin
    });
  }

  setDisplayName(name) {
    var nm = String(name || '').trim();
    this.displayName = nm;
    if (this.transport) this.transport.nodeDisplayName = nm;
  }

  send(type, payload, target) {
    var msg = {
      type: type,
      from: this.userId,
      roomCode: this.roomCode ? String(this.roomCode).toUpperCase() : this.roomCode,
      payload: payload,
      timestamp: Date.now()
    };
    if (target) msg.to = target;

    if (payload && typeof payload === 'object') {
      if (payload.role && !msg.role) msg.role = payload.role;
      if (payload.block) msg.block = payload.block;
      if (payload.adminUserId) msg.adminUserId = payload.adminUserId;
    }

    this.transport.send(msg);
    this._emit(type, msg);
  }

  getPeerCount() {
    if (this.transport && typeof this.transport.getPeerCount === 'function') {
      return this.transport.getPeerCount();
    }
    return this.peerCount;
  }

  on(event, handler) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
    this.eventHandlers.get(event).push(handler);
  }

  off(event, handler) {
    var list = this.eventHandlers.get(event) || [];
    var idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  _emit(event, data) {
    var handlers = this.eventHandlers.get(event) || [];
    handlers.forEach(function (h) {
      try { h(data); } catch (e) { console.error(e); }
    });
  }

  disconnect() {
    if (this.transport && this.transport.disconnect) this.transport.disconnect();
  }

  _generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }
}

window.NetworkManager = NetworkManager;
} // end guard
