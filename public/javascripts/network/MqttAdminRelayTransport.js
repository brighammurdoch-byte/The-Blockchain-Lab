/**
 * MqttAdminRelayTransport
 *
 * Cross-device classroom relay via public MQTT over WebSocket + BroadcastChannel.
 * Phones / laptops on different networks can reach the instructor hub reliably
 * (WebRTC trackers are often blocked on mobile / school Wi‑Fi).
 *
 * Topics: blockchain-lab/v1/{ROOM}/bus
 * Brokers: EMQX / HiveMQ public WSS endpoints (no account).
 */

(function (global) {
  var BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];

  function MqttAdminRelayTransport() {
    this.routingMode = 'hub';
    this.roomCode = null;
    this.userId = null;
    this.role = null;
    this.isAdmin = false;
    this.onMessage = null;
    this.onPeerCountChange = null;
    this.client = null;
    this.channel = null;
    this._seenKeys = new Set();
    this._presence = new Map(); // userId -> lastSeen
    this._announceTimer = null;
    this._brokerUrl = null;
    this._connected = false;
  }

  MqttAdminRelayTransport.prototype.initAsAdmin = async function (roomCode, userId) {
    this.isAdmin = true;
    this.role = 'admin';
    this.roomCode = String(roomCode || '').toUpperCase();
    this.userId = userId;
    await this._initAll();
    this._announcePresence();
    console.log('[MqttRelay] Admin hub ready on', this._brokerUrl, 'room', this.roomCode);
  };

  MqttAdminRelayTransport.prototype.joinRoom = async function (roomCode, userId, role) {
    this.isAdmin = role === 'admin';
    this.role = role || 'miner';
    this.roomCode = String(roomCode || '').toUpperCase();
    this.userId = userId;
    await this._initAll();
    this._announcePresence();
    this.send({
      type: 'peer-joined',
      roomCode: this.roomCode,
      from: userId,
      role: this.role,
      timestamp: Date.now()
    });
    console.log('[MqttRelay] Joined room', this.roomCode, 'as', userId, this.role, 'via', this._brokerUrl);
  };

  MqttAdminRelayTransport.prototype.setRoutingMode = function (mode) {
    this.routingMode = mode === 'mesh' ? 'mesh' : 'hub';
  };

  MqttAdminRelayTransport.prototype.getPeerCount = function () {
    var now = Date.now();
    var n = 0;
    this._presence.forEach(function (ts, id) {
      if (now - ts < 20000) n += 1;
    });
    // Exclude self
    if (this.userId && this._presence.has(this.userId) && (now - this._presence.get(this.userId) < 20000)) {
      n = Math.max(0, n - 1);
    }
    return n;
  };

  MqttAdminRelayTransport.prototype._topic = function () {
    return 'blockchain-lab/v1/' + this.roomCode + '/bus';
  };

  MqttAdminRelayTransport.prototype._initAll = async function () {
    this._initBroadcastChannel();
    await this._initMqtt();
    var self = this;
    this._announceTimer = setInterval(function () {
      self._announcePresence();
      self._emitPeerCount();
    }, 4000);
  };

  MqttAdminRelayTransport.prototype._initBroadcastChannel = function () {
    if (typeof BroadcastChannel === 'undefined') return;
    var self = this;
    try {
      this.channel = new BroadcastChannel('blockchain-lab-relay-' + this.roomCode);
      this.channel.onmessage = function (event) {
        self._handleIncoming(event.data, 'broadcast');
      };
    } catch (e) {
      console.warn('[MqttRelay] BroadcastChannel unavailable', e);
    }
  };

  MqttAdminRelayTransport.prototype._getMqttConnect = function () {
    var lib = global.mqtt;
    if (!lib) return null;
    if (typeof lib.connect === 'function') return lib.connect.bind(lib);
    if (lib.default && typeof lib.default.connect === 'function') {
      return lib.default.connect.bind(lib.default);
    }
    return null;
  };

  MqttAdminRelayTransport.prototype._initMqtt = async function () {
    var connectFn = this._getMqttConnect();
    if (!connectFn) {
      console.warn('[MqttRelay] mqtt.js not loaded — BroadcastChannel only (phones will fail)');
      return;
    }

    var self = this;
    var brokers = (global.LAB_MQTT_BROKERS && global.LAB_MQTT_BROKERS.length)
      ? global.LAB_MQTT_BROKERS
      : BROKERS;

    var lastErr = null;
    for (var i = 0; i < brokers.length; i++) {
      var url = brokers[i];
      try {
        await self._connectBroker(connectFn, url);
        self._brokerUrl = url;
        return;
      } catch (e) {
        lastErr = e;
        console.warn('[MqttRelay] Broker failed', url, e && e.message ? e.message : e);
      }
    }
    throw lastErr || new Error('All MQTT brokers failed');
  };

  MqttAdminRelayTransport.prototype._connectBroker = function (connectFn, url) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var clientId = 'blab-' + String(self.roomCode || 'x').slice(0, 6) + '-' +
        String(self.userId || 'u').replace(/[^a-zA-Z0-9]/g, '').slice(-10) + '-' +
        Math.random().toString(36).slice(2, 7);

      var client = connectFn(url, {
        clientId: clientId,
        clean: true,
        connectTimeout: 10000,
        reconnectPeriod: 3000,
        keepalive: 30
      });

      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { client.end(true); } catch (e) {}
        reject(new Error('MQTT connect timeout: ' + url));
      }, 12000);

      client.on('connect', function () {
        if (settled) return;
        client.subscribe(self._topic(), { qos: 0 }, function (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) {
            try { client.end(true); } catch (e) {}
            reject(err);
            return;
          }
          self.client = client;
          self._connected = true;
          client.on('message', function (_topic, payload) {
            self._onMqttMessage(payload);
          });
          client.on('close', function () {
            self._connected = false;
          });
          client.on('reconnect', function () {
            self._connected = true;
          });
          resolve();
        });
      });

      client.on('error', function (err) {
        console.warn('[MqttRelay] client error', err && err.message ? err.message : err);
        if (!settled && !self.client) {
          // wait for timeout / connect
        }
      });
    });
  };

  MqttAdminRelayTransport.prototype._onMqttMessage = function (payload) {
    var text = payload;
    if (payload && typeof payload !== 'string') {
      try {
        text = typeof TextDecoder !== 'undefined'
          ? new TextDecoder().decode(payload)
          : payload.toString();
      } catch (e) {
        text = String(payload);
      }
    }
    var msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      return;
    }
    this._handleIncoming(msg, 'mqtt');
  };

  MqttAdminRelayTransport.prototype._announcePresence = function () {
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

  MqttAdminRelayTransport.prototype._emitPeerCount = function () {
    if (typeof this.onPeerCountChange === 'function') {
      this.onPeerCountChange(this.getPeerCount());
    }
  };

  MqttAdminRelayTransport.prototype._dedupeKey = function (msg) {
    return [
      msg.type,
      msg.from || '',
      msg.timestamp || '',
      msg.to || '',
      (msg.payload && msg.payload.block && msg.payload.block.hash) || '',
      (msg.block && msg.block.hash) || ''
    ].join('|');
  };

  MqttAdminRelayTransport.prototype._handleIncoming = function (msg, source) {
    if (!msg || typeof msg !== 'object') return;
    var msgRoom = msg.roomCode ? String(msg.roomCode).toUpperCase() : '';
    var myRoom = this.roomCode ? String(this.roomCode).toUpperCase() : '';
    if (msgRoom && myRoom && msgRoom !== myRoom) return;
    // Ignore our own publishes (MQTT + local echo handled in NetworkManager)
    if (msg.from && msg.from === this.userId) return;

    var key = this._dedupeKey(msg);
    if (this._seenKeys.has(key)) return;
    this._seenKeys.add(key);
    if (this._seenKeys.size > 800) {
      this._seenKeys = new Set(Array.from(this._seenKeys).slice(-300));
    }

    if (msg.from) {
      this._presence.set(msg.from, Date.now());
      this._emitPeerCount();
    }

    if (typeof this.onMessage === 'function') {
      this.onMessage(msg);
    }
  };

  MqttAdminRelayTransport.prototype.send = function (message) {
    if (!message) return;
    if (!message.roomCode) message.roomCode = this.roomCode;
    if (!message.from) message.from = this.userId;
    if (!message.timestamp) message.timestamp = Date.now();

    if (this.channel) {
      try { this.channel.postMessage(message); } catch (e) {}
    }

    if (this.client && this._connected) {
      try {
        var body = JSON.stringify(message);
        // Public brokers typically allow ~256KB; keep classroom payloads modest
        this.client.publish(this._topic(), body, { qos: 0, retain: false });
      } catch (e) {
        console.warn('[MqttRelay] publish failed', e);
      }
    }
  };

  MqttAdminRelayTransport.prototype.disconnect = function () {
    if (this._announceTimer) {
      clearInterval(this._announceTimer);
      this._announceTimer = null;
    }
    if (this.channel) {
      try { this.channel.close(); } catch (e) {}
      this.channel = null;
    }
    if (this.client) {
      try { this.client.end(true); } catch (e) {}
      this.client = null;
    }
    this._connected = false;
    this._presence.clear();
  };

  global.MqttAdminRelayTransport = MqttAdminRelayTransport;
})(typeof window !== 'undefined' ? window : globalThis);
