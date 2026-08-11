/**
 * P2PAdminRelayTransport
 *
 * Cross-device Admin-hosted relay using p2pt (WebTorrent trackers + WebRTC).
 * Also mirrors traffic on BroadcastChannel so same-origin Test Peer tabs still work.
 *
 * Hub routing:
 * - Students send to the admin peer (or broadcast until admin is known)
 * - Admin validates upstream and rebroadcasts to all other peers
 */

(function (global) {
  var DEFAULT_TRACKERS = [
    'wss://tracker.btorrent.xyz',
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.files.fm:7073/announce'
  ];

  function P2PAdminRelayTransport(options) {
    options = options || {};
    this.routingMode = options.routingMode || 'hub'; // 'hub' | 'mesh'
    this.p2pt = null;
    this.roomCode = null;
    this.userId = null;
    this.role = null;
    this.isAdmin = false;
    this.onMessage = null;
    this.onPeerCountChange = null;
    this.connectedPeers = new Map(); // peerId -> peer
    this.adminPeerId = null;
    this.adminUserId = null;
    this.channel = null; // BroadcastChannel mirror
    this._started = false;
    this._seenKeys = new Set();
  }

  P2PAdminRelayTransport.prototype.initAsAdmin = async function (roomCode, userId) {
    this.isAdmin = true;
    this.role = 'admin';
    this.roomCode = String(roomCode || '').toUpperCase();
    this.userId = userId;
    this.adminUserId = userId;
    await this._initAll(this.roomCode);
    this._announcePresence();
    console.log('[P2PAdminRelay] Admin announced room:', this.roomCode, 'routing:', this.routingMode);
  };

  P2PAdminRelayTransport.prototype.joinRoom = async function (roomCode, userId, role) {
    this.isAdmin = role === 'admin';
    this.role = role || 'miner';
    this.roomCode = String(roomCode || '').toUpperCase();
    this.userId = userId;
    await this._initAll(this.roomCode);
    this._announcePresence();
    // Tell the hub we joined (same shape as BroadcastChannel transport)
    this.send({
      type: 'peer-joined',
      roomCode: this.roomCode,
      from: userId,
      role: this.role,
      timestamp: Date.now()
    });
    console.log('[P2PAdminRelay] Joined room:', this.roomCode, 'as', userId, this.role);
  };

  P2PAdminRelayTransport.prototype.setRoutingMode = function (mode) {
    this.routingMode = mode === 'mesh' ? 'mesh' : 'hub';
    console.log('[P2PAdminRelay] Routing mode set to', this.routingMode);
  };

  P2PAdminRelayTransport.prototype.getPeerCount = function () {
    return this.connectedPeers.size;
  };

  P2PAdminRelayTransport.prototype._initAll = async function (roomCode) {
    this._initBroadcastChannel(roomCode);
    await this._initP2PT(roomCode);
  };

  P2PAdminRelayTransport.prototype._initBroadcastChannel = function (roomCode) {
    if (typeof BroadcastChannel === 'undefined') return;
    var self = this;
    var channelName = 'blockchain-lab-relay-' + roomCode;
    try {
      this.channel = new BroadcastChannel(channelName);
      this.channel.onmessage = function (event) {
        self._handleIncoming(event.data, 'broadcast');
      };
    } catch (e) {
      console.warn('[P2PAdminRelay] BroadcastChannel unavailable', e);
    }
  };

  P2PAdminRelayTransport.prototype._initP2PT = async function (roomCode) {
    var P2PTCtor = global.P2PT;
    if (typeof P2PTCtor === 'undefined') {
      console.warn('[P2PAdminRelay] p2pt not loaded — BroadcastChannel-only fallback');
      return;
    }

    var self = this;
    var trackers = (global.LAB_P2P_TRACKERS && global.LAB_P2P_TRACKERS.length)
      ? global.LAB_P2P_TRACKERS
      : DEFAULT_TRACKERS;

    var identifier = 'blockchain-lab-' + String(roomCode).toUpperCase();
    this.p2pt = new P2PTCtor(trackers, identifier);

    this.p2pt.on('peerconnect', function (peer) {
      console.log('[P2PAdminRelay] Peer connected:', peer.id);
      self.connectedPeers.set(peer.id, peer);
      self._emitPeerCount();
      // Introduce ourselves so the peer learns admin identity
      self._sendToPeer(peer, {
        type: 'peer-hello',
        roomCode: self.roomCode,
        from: self.userId,
        role: self.role || (self.isAdmin ? 'admin' : 'miner'),
        isAdmin: self.isAdmin,
        timestamp: Date.now()
      });
      if (!self.isAdmin) {
        // Ask for state once a peer appears (likely the admin)
        self.send({
          type: 'request-state',
          roomCode: self.roomCode,
          from: self.userId,
          payload: { from: self.userId },
          timestamp: Date.now()
        });
      }
    });

    this.p2pt.on('peerclose', function (peer) {
      self.connectedPeers.delete(peer.id);
      if (self.adminPeerId === peer.id) {
        self.adminPeerId = null;
      }
      self._emitPeerCount();
    });

    this.p2pt.on('msg', function (peer, data) {
      var msg = data;
      if (typeof data === 'string') {
        try { msg = JSON.parse(data); } catch (e) { return; }
      }
      // msg may already be an object from p2pt JSON mode
      if (msg && typeof msg === 'object' && msg.msg && !msg.type) {
        try {
          msg = typeof msg.msg === 'string' ? JSON.parse(msg.msg) : msg.msg;
        } catch (e) { /* keep */ }
      }
      self._handleIncoming(msg, 'webrtc', peer);
    });

    this.p2pt.on('trackerwarning', function (err) {
      console.warn('[P2PAdminRelay] Tracker warning:', err && err.message ? err.message : err);
    });

    await this.p2pt.start();
    this._started = true;
    // Periodically refresh peer discovery
    this._announceTimer = setInterval(function () {
      if (self.p2pt && typeof self.p2pt.requestMorePeers === 'function') {
        self.p2pt.requestMorePeers().catch(function () {});
      }
    }, 15000);
  };

  P2PAdminRelayTransport.prototype._announcePresence = function () {
    this.send({
      type: this.isAdmin ? 'admin-presence' : 'peer-hello',
      roomCode: this.roomCode,
      from: this.userId,
      adminUserId: this.isAdmin ? this.userId : undefined,
      role: this.role,
      isAdmin: this.isAdmin,
      timestamp: Date.now()
    });
  };

  P2PAdminRelayTransport.prototype._emitPeerCount = function () {
    if (typeof this.onPeerCountChange === 'function') {
      this.onPeerCountChange(this.connectedPeers.size);
    }
  };

  P2PAdminRelayTransport.prototype._dedupeKey = function (msg) {
    return [
      msg.type,
      msg.from || '',
      msg.timestamp || '',
      msg.to || '',
      (msg.payload && msg.payload.block && msg.payload.block.hash) || '',
      (msg.block && msg.block.hash) || ''
    ].join('|');
  };

  P2PAdminRelayTransport.prototype._handleIncoming = function (msg, source, peer) {
    if (!msg || typeof msg !== 'object') return;
    var msgRoom = msg.roomCode ? String(msg.roomCode).toUpperCase() : '';
    var myRoom = this.roomCode ? String(this.roomCode).toUpperCase() : '';
    if (msgRoom && myRoom && msgRoom !== myRoom) return;
    if (msg.from && msg.from === this.userId && !msg.relayedByAdmin) return;

    var key = this._dedupeKey(msg);
    if (this._seenKeys.has(key)) return;
    this._seenKeys.add(key);
    if (this._seenKeys.size > 500) {
      // simple trim
      this._seenKeys = new Set(Array.from(this._seenKeys).slice(-200));
    }

    if ((msg.type === 'admin-presence' || msg.isAdmin || msg.role === 'admin') && msg.from) {
      this.adminUserId = msg.adminUserId || msg.from;
      if (peer && peer.id) this.adminPeerId = peer.id;
    }
    if (msg.type === 'peer-hello' && msg.isAdmin && peer && peer.id) {
      this.adminUserId = msg.from;
      this.adminPeerId = peer.id;
    }

    if (typeof this.onMessage === 'function') {
      this.onMessage(msg);
    }

    // Hub relay: admin rebroadcasts others' messages (except already-relayed)
    if (this.routingMode === 'hub' && this.isAdmin && msg.from !== this.userId && !msg.relayedByAdmin) {
      var relayTypes = {
        'peer-joined': true,
        'block-submitted': true,
        'transaction-submitted': true,
        'hashrate-report': true,
        'request-state': true,
        'peer-hello': true
      };
      // Always relay application traffic from students so observers see it
      if (msg.type && msg.type !== 'peer-hello') {
        var relayed = Object.assign({}, msg, { relayedByAdmin: true });
        this._broadcast(relayed, peer ? peer.id : null, source);
      } else if (relayTypes[msg.type]) {
        var relayed2 = Object.assign({}, msg, { relayedByAdmin: true });
        this._broadcast(relayed2, peer ? peer.id : null, source);
      }
    }
  };

  P2PAdminRelayTransport.prototype.send = function (message) {
    if (!message) return;
    if (!message.roomCode) message.roomCode = this.roomCode;
    if (!message.from) message.from = this.userId;
    if (!message.timestamp) message.timestamp = Date.now();

    // Targeted delivery
    if (message.to && this.routingMode === 'hub') {
      this._sendTargeted(message);
      return;
    }

    if (this.routingMode === 'mesh' || this.isAdmin) {
      this._broadcast(message, null, null);
      return;
    }

    // Hub client: prefer admin peer
    if (this.adminPeerId && this.connectedPeers.has(this.adminPeerId)) {
      this._sendToPeer(this.connectedPeers.get(this.adminPeerId), message);
      if (this.channel) {
        try { this.channel.postMessage(message); } catch (e) {}
      }
      return;
    }

    // Admin not known yet — broadcast so admin (and local tabs) hear us
    this._broadcast(message, null, null);
  };

  P2PAdminRelayTransport.prototype._sendTargeted = function (message) {
    var sent = false;
    // Try match by known admin user / any peer (we don't map userId→peer reliably yet)
    if (this.adminPeerId && this.connectedPeers.has(this.adminPeerId)) {
      this._sendToPeer(this.connectedPeers.get(this.adminPeerId), message);
      sent = true;
    }
    // Also broadcast so BroadcastChannel / mesh peers with matching filter can receive
    this._broadcast(message, null, null);
    return sent;
  };

  P2PAdminRelayTransport.prototype._broadcast = function (message, excludePeerId, excludeSource) {
    var self = this;
    if (excludeSource !== 'broadcast' && this.channel) {
      try { this.channel.postMessage(message); } catch (e) {}
    }
    if (!this.p2pt) return;
    this.connectedPeers.forEach(function (peer, peerId) {
      if (excludePeerId && peerId === excludePeerId) return;
      self._sendToPeer(peer, message);
    });
  };

  P2PAdminRelayTransport.prototype._sendToPeer = function (peer, message) {
    if (!this.p2pt || !peer) return;
    try {
      // p2pt.send(peer, msg) — objects are JSON-encoded by the library
      this.p2pt.send(peer, message);
    } catch (e) {
      console.warn('[P2PAdminRelay] send failed', e);
    }
  };

  P2PAdminRelayTransport.prototype.disconnect = function () {
    if (this._announceTimer) {
      clearInterval(this._announceTimer);
      this._announceTimer = null;
    }
    if (this.channel) {
      try { this.channel.close(); } catch (e) {}
      this.channel = null;
    }
    if (this.p2pt) {
      try { this.p2pt.destroy(); } catch (e) {}
      this.p2pt = null;
    }
    this.connectedPeers.clear();
  };

  global.P2PAdminRelayTransport = P2PAdminRelayTransport;
})(typeof window !== 'undefined' ? window : globalThis);
