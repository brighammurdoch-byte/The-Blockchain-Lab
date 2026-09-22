/**
 * Mining Web Worker — runs PoW off the main thread so desktop/mobile
 * background tabs keep hashing (main-thread timers are heavily throttled).
 *
 * Messages in:
 *   { command: 'init', sha256Url }
 *   { command: 'start', gen, block, difficulty, delay, batchSize, nonce, totalIterations, startTime }
 *   { command: 'setPace', delay, batchSize }
 *   { command: 'stop' }
 *
 * Messages out:
 *   { type: 'ready' }
 *   { type: 'progress', gen, nonce, totalIterations, hashrate, startTime }
 *   { type: 'found', gen, block, hash, nonce, totalIterations, startTime }
 *   { type: 'error', message }
 */
/* eslint-disable no-restricted-globals */

var running = false;
var job = null;
var nonce = 0;
var totalIterations = 0;
var startTime = 0;
var timer = null;
var cryptoReady = false;
var shaInitPromise = null;

function clearTimer() {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
}

function ensureCrypto(sha256Url) {
  if (cryptoReady && typeof CryptoJS !== 'undefined') {
    return Promise.resolve();
  }
  if (shaInitPromise) return shaInitPromise;
  shaInitPromise = new Promise(function (resolve, reject) {
    try {
      if (typeof CryptoJS === 'undefined') {
        if (!sha256Url) {
          reject(new Error('sha256Url required to load CryptoJS in worker'));
          return;
        }
        importScripts(sha256Url);
      }
      if (typeof CryptoJS === 'undefined' || !CryptoJS.SHA256) {
        reject(new Error('CryptoJS.SHA256 unavailable after importScripts'));
        return;
      }
      cryptoReady = true;
      resolve();
    } catch (e) {
      reject(e);
    }
  });
  return shaInitPromise;
}

function sha256Hex(data) {
  return CryptoJS.SHA256(data).toString();
}

function canonicalizeObject(obj) {
  if (Array.isArray(obj)) {
    return obj.map(function (item) {
      return canonicalizeObject(item);
    });
  }
  if (obj !== null && typeof obj === 'object') {
    var sorted = {};
    Object.keys(obj)
      .sort()
      .forEach(function (key) {
        sorted[key] = canonicalizeObject(obj[key]);
      });
    return sorted;
  }
  return obj;
}

function isValidHash(hash, difficulty) {
  if (difficulty == null) return false;
  if (typeof difficulty === 'number') {
    difficulty = { leadingZeros: Math.max(1, Math.floor(difficulty)), secondaryHex: 'F' };
  }
  if (typeof difficulty !== 'object') return false;

  var zeros = difficulty.leadingZeros != null ? difficulty.leadingZeros : 3;
  for (var i = 0; i < zeros; i++) {
    if (hash[i] !== '0') return false;
  }

  if (difficulty.secondaryHex != null && String(difficulty.secondaryHex) !== '') {
    var nextChar = hash.charAt(zeros);
    if (nextChar && nextChar.toLowerCase() > String(difficulty.secondaryHex).toLowerCase()) {
      return false;
    }
  }
  return true;
}

var TAB_HASH_CAP = 750;

function clampPace(delay, batchSize) {
  var batch = batchSize > 0 ? Math.floor(batchSize) : 40;
  if (batch > 80) batch = 80;
  if (batch < 1) batch = 1;
  var minDelay = Math.ceil((batch / TAB_HASH_CAP) * 1000);
  if (minDelay < 20) minDelay = 20;
  var d = Number(delay);
  if (!(d >= minDelay)) d = minDelay;
  return { delay: d, batchSize: batch };
}

function mineBatch() {
  if (!running || !job || !job.block) return;

  var pace = clampPace(job.delay, job.batchSize);
  job.delay = pace.delay;
  job.batchSize = pace.batchSize;

  var block = job.block;
  var difficulty = job.difficulty;
  var batchSize = pace.batchSize;
  var i;
  var blockObj;
  var hash;
  var elapsed;
  var hashrate;

  for (i = 0; i < batchSize; i++) {
    if (!running) return;

    blockObj = {
      index: block.index,
      timestamp: block.timestamp,
      nonce: nonce,
      previousHash: block.previousHash,
      transactions: block.transactions,
      miner: block.miner,
      difficulty: block.difficulty,
      forkId: block.forkId
    };

    hash = sha256Hex(JSON.stringify(canonicalizeObject(blockObj)));

    if (isValidHash(hash, difficulty)) {
      block.hash = hash;
      block.nonce = nonce;
      elapsed = Math.max(0.05, (Date.now() - startTime) / 1000);
      hashrate = Math.max(1, Math.floor((totalIterations + 1) / elapsed));
      self.postMessage({
        type: 'found',
        gen: job.gen,
        block: block,
        hash: hash,
        nonce: nonce,
        totalIterations: totalIterations + 1,
        hashrate: hashrate,
        startTime: startTime
      });
      // Pause until main thread sends the next start (or stop)
      running = false;
      clearTimer();
      return;
    }

    nonce++;
    totalIterations++;
  }

  elapsed = Math.max(0.1, (Date.now() - startTime) / 1000);
  hashrate = Math.max(1, Math.floor(totalIterations / elapsed));

  self.postMessage({
    type: 'progress',
    gen: job.gen,
    nonce: nonce,
    totalIterations: totalIterations,
    hashrate: hashrate,
    startTime: startTime
  });

  if (!running) return;

  // Gap after each small batch so this worker cannot pin a core.
  timer = setTimeout(mineBatch, job.delay);
}

self.onmessage = function (e) {
  var d = e.data || {};
  var cmd = d.command;

  if (cmd === 'init') {
    ensureCrypto(d.sha256Url)
      .then(function () {
        self.postMessage({ type: 'ready' });
      })
      .catch(function (err) {
        self.postMessage({
          type: 'error',
          message: (err && err.message) || String(err)
        });
      });
    return;
  }

  if (cmd === 'start') {
    ensureCrypto(d.sha256Url)
      .then(function () {
        clearTimer();
        running = true;
        var pace = clampPace(d.delay, d.batchSize);
        job = {
          gen: d.gen,
          block: d.block,
          difficulty: d.difficulty,
          delay: pace.delay,
          batchSize: pace.batchSize
        };
        nonce = d.nonce || 0;
        totalIterations = d.totalIterations || 0;
        startTime = d.startTime || Date.now();
        mineBatch();
      })
      .catch(function (err) {
        self.postMessage({
          type: 'error',
          message: (err && err.message) || String(err)
        });
      });
    return;
  }

  if (cmd === 'setPace') {
    if (job) {
      var pace = clampPace(
        d.delay != null ? d.delay : job.delay,
        d.batchSize != null ? d.batchSize : job.batchSize
      );
      job.delay = pace.delay;
      job.batchSize = pace.batchSize;
    }
    return;
  }

  if (cmd === 'stop') {
    running = false;
    clearTimer();
    job = null;
    return;
  }
};
