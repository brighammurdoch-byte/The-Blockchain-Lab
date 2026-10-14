/**
 * Canonical block digest shared by the miner and the hub.
 *
 * mineBatch hashes this field set, with keys sorted recursively, then SHA-256.
 * Synchronous on purpose: tryAddBlock cannot wait on WebCrypto subtle.digest.
 * CryptoJS.SHA256 (the classroom miner) when it is already loaded; otherwise
 * the same UTF-8 SHA-256, so node tests and the hub agree.
 */
(function (root) {
  'use strict';

  function canonicalizeObject(obj) {
    if (Array.isArray(obj)) {
      return obj.map(function (item) {
        return canonicalizeObject(item);
      });
    }
    if (obj !== null && typeof obj === 'object') {
      var sorted = {};
      Object.keys(obj).sort().forEach(function (key) {
        sorted[key] = canonicalizeObject(obj[key]);
      });
      return sorted;
    }
    return obj;
  }

  /** Same properties miningWorker.js mineBatch puts in blockObj. */
  function blockFieldsForHash(block) {
    block = block || {};
    return {
      index: block.index,
      timestamp: block.timestamp,
      nonce: block.nonce,
      previousHash: block.previousHash,
      transactions: block.transactions,
      miner: block.miner,
      difficulty: block.difficulty,
      forkId: block.forkId
    };
  }

  function utf8Bytes(str) {
    var out = [];
    var s = String(str);
    var i;
    for (i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var c2 = s.charCodeAt(++i);
        var u = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        out.push(
          0xf0 | (u >> 18),
          0x80 | ((u >> 12) & 0x3f),
          0x80 | ((u >> 6) & 0x3f),
          0x80 | (u & 0x3f)
        );
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  var K = null;
  var H0 = null;

  function initConstants() {
    if (K) return;
    K = new Array(64);
    H0 = new Array(8);
    var prime = [];
    var isComposite = {};
    var c;
    for (c = 2; prime.length < 64; c++) {
      if (isComposite[c]) continue;
      var m;
      for (m = c * c; m < 320; m += c) isComposite[m] = 1;
      prime.push(c);
    }
    for (c = 0; c < 8; c++) H0[c] = (Math.pow(prime[c], 0.5) * 4294967296) | 0;
    for (c = 0; c < 64; c++) K[c] = (Math.pow(prime[c], 1 / 3) * 4294967296) | 0;
  }

  function sha256HexPure(message) {
    initConstants();
    var bytes = utf8Bytes(message);
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while ((bytes.length % 64) !== 56) bytes.push(0);
    var hi = Math.floor(bitLen / 4294967296);
    var lo = bitLen >>> 0;
    var shift;
    for (shift = 24; shift >= 0; shift -= 8) bytes.push((hi >>> shift) & 255);
    for (shift = 24; shift >= 0; shift -= 8) bytes.push((lo >>> shift) & 255);

    var h = H0.slice();
    var w = new Array(64);
    var off;
    for (off = 0; off < bytes.length; off += 64) {
      var i;
      for (i = 0; i < 16; i++) {
        var p = off + i * 4;
        w[i] = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) | 0;
      }
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c0 = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ ((~e) & g);
        var temp1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c0) ^ (b & c0);
        var temp2 = (S0 + maj) | 0;
        hh = g;
        g = f;
        f = e;
        e = (d + temp1) | 0;
        d = c0;
        c0 = b;
        b = a;
        a = (temp1 + temp2) | 0;
      }
      h[0] = (h[0] + a) | 0;
      h[1] = (h[1] + b) | 0;
      h[2] = (h[2] + c0) | 0;
      h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0;
      h[5] = (h[5] + f) | 0;
      h[6] = (h[6] + g) | 0;
      h[7] = (h[7] + hh) | 0;
    }
    var hex = '';
    for (var hiWord = 0; hiWord < 8; hiWord++) {
      for (shift = 28; shift >= 0; shift -= 4) {
        hex += ((h[hiWord] >>> shift) & 15).toString(16);
      }
    }
    return hex;
  }

  function sha256Hex(data) {
    var text = data == null ? '' : String(data);
    var cryptoJs = (typeof CryptoJS !== 'undefined') ? CryptoJS : null;
    if (cryptoJs && typeof cryptoJs.SHA256 === 'function') {
      return cryptoJs.SHA256(text).toString();
    }
    return sha256HexPure(text);
  }

  function hashFields(fields) {
    return sha256Hex(JSON.stringify(canonicalizeObject(fields)));
  }

  function hashBlock(block) {
    return hashFields(blockFieldsForHash(block));
  }

  var api = {
    canonicalizeObject: canonicalizeObject,
    blockFieldsForHash: blockFieldsForHash,
    sha256Hex: sha256Hex,
    sha256HexPure: sha256HexPure,
    hashFields: hashFields,
    hashBlock: hashBlock
  };

  root.LabBlockHash = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
