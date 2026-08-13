/**
 * Blockchain Lab Participant (Miner) Interface
 * Handle mining blocks and sending transactions
 */

let sessionId = null;
let userId = null;
let isMining = false;
let networkPaused = false;
let cpuLimitPercent = 20;
let miningWorker = null;
let miningWorkerReady = false;
let miningWorkerFailed = false; // after hard failure, stay on main-thread mining
let miningJobGen = 0;
let lastWorkerProgressAt = 0;
let lastHashrateEmitAt = 0;
let currentMiningBlock = null;
let miningWakeLock = null;
let miningKeepaliveTimer = null;
let mainThreadMineTimer = null;
let lastRemineAt = 0;
/** Highest block index the hub has confirmed (classic main). Caps optimistic race-ahead. */
let hubConfirmedHeight = 0;
/** When set, we submitted hub+1 and are waiting for the hub before mining further. */
let waitingForHubSince = 0;
let waitingForHubIndex = null;
let lastSubmittedBlock = null;
const submittedSlots = new Set();

function blockSlotKey(block) {
  if (!block) return '';
  return String(block.previousHash || '') + '|' + String(block.index) + '|' + String(block.forkId || 'classic');
}
let openTxPanels = new Set();
let originalValidatorCode = '';
let localChainTipHash = null;
let isColluding = false;
let collusionTipHash = null;
let collusionHeight = 0;
let collusionTransactions = [];
let lastKnownAdminSettings = null;
let myForkChoice = 'classic';
let pendingForkHeight = null;
let pendingForkName = null;
/** Prevent hard-fork modal from re-opening on MQTT redelivery / initial-state resync. */
let shownForkProposalKey = null;
let forkChoiceLockedKey = null;
let lastKnownOrphans = []; // Competing / hard-fork tips from hub
/** Cached roster so chain re-renders keep miner names (mobile often re-renders without a payload). */
let lastKnownParticipants = [];
/** Best known tip on the NEW hard-fork branch (miners on "new" stick to this). */
let localNewForkTip = null;
/** Best known tip on the CLASSIC side after activation (miners on "classic" stick to this). */
let localClassicForkTip = null;
let seenBlocks = new Set(); // Prevent infinite gossip loops
let submittedBlockHashes = new Set(); // Avoid double-submit of the same PoW solution
let localPendingTxs = []; // Mempool mirror from hub
let remineTxTimer = null; // Debounce remine when mempool updates
let rtcPeerConnections = {}; // WebRTC connections
let rtcDataChannels = {}; // WebRTC data channels
let pendingDemoCode = null; // Store admin-triggered demo code
let demoCodeApplyAtBlock = null; // Block height when demo code should apply
let isSyncingChain = false; // Prevent multiple concurrent sync requests
let lastFailedSyncHeight = 0; // Prevent infinite sync loops on incompatible hard forks
const DEBUG_MODE = localStorage.getItem('blockchainLabDebug') === 'true'; // Enable via console: localStorage.setItem('blockchainLabDebug', 'true')

// Client-relay networking (only mode)
let networkMode = null;
let net = null;

// Controlled logging that respects DEBUG_MODE
function debugLog(...args) {
  if (DEBUG_MODE) {
    console.log('[BlockchainLab]', ...args);
  }
}

function debugWarn(...args) {
  if (DEBUG_MODE) {
    console.warn('[BlockchainLab]', ...args);
  }
}

function applyMyBalanceFromParticipants(participants) {
  if (!participants || !participants.length || !userId) return;
  const me = participants.find(function (p) {
    return p && (p.userId === userId || p.address === userId || p.id === userId);
  });
  if (me && me.balance !== undefined && me.balance !== null) {
    $('#yourBalance').text(me.balance);
  }
  if (me) {
    if (me.blocksMined !== undefined) $('#blocksMined').text(me.blocksMined);
    else if (me.minedBlocks !== undefined) $('#blocksMined').text(me.minedBlocks);
  }
}

/**
 * Restart the mining loop on the current hub tip without flipping isMining off.
 * @param {{ force?: boolean }} [opts] force=true skips debounce (hub chain sync)
 */
function remineOnCanonicalTip(opts) {
  if (!isMining || isColluding || networkPaused) return;
  const force = !!(opts && opts.force);
  // Debounce: presence/roster floods must not thrash the worker every ms
  const now = Date.now();
  if (!force && now - lastRemineAt < 250) return;
  lastRemineAt = now;
  // Invalidate in-flight worker job; fetchDataAndMine posts a new gen
  miningJobGen++;
  fetchDataAndMine();
}

/** Last classic block at or below the hub-confirmed height (ignore optimistic tail). */
function getHubConfirmedClassicTip(main) {
  main = main || window.lastRelayedChain || [];
  for (let i = main.length - 1; i >= 0; i--) {
    const b = main[i];
    if (!b || !b.hash) continue;
    if (isNewForkId(b.forkId)) continue;
    if (b.index == null || Number(b.index) <= hubConfirmedHeight) return b;
  }
  return null;
}

function trimOptimisticTail() {
  const chain = window.lastRelayedChain;
  if (!chain || !chain.length) return;
  while (
    chain.length &&
    chain[chain.length - 1] &&
    chain[chain.length - 1].index != null &&
    Number(chain[chain.length - 1].index) > hubConfirmedHeight
  ) {
    chain.pop();
  }
}

function showWaitingForHub(index) {
  waitingForHubSince = waitingForHubSince || Date.now();
  waitingForHubIndex = index != null ? Number(index) : waitingForHubIndex;
  currentMiningBlock = null;
  const label = waitingForHubIndex != null ? (' #' + waitingForHubIndex) : '';
  $('#miningActivity').html(
    '<div class="alert alert-warning">' +
      '<p><strong>Waiting for the network to confirm block' + label + '…</strong></p>' +
      '<p class="small" style="margin-bottom:0;">You already found the next block. Hashing pauses until the instructor hub accepts it, then mining continues. If it never arrives, we retry automatically.</p>' +
    '</div>'
  );
}

function clearWaitingForHub() {
  waitingForHubSince = 0;
  waitingForHubIndex = null;
}

/** Absolute URL helpers for the mining worker (blob importScripts needs absolute). */
function getLabAssetAbsoluteUrl(path) {
  const rel = (window.LabPaths && typeof LabPaths.assetUrl === 'function')
    ? LabPaths.assetUrl(path)
    : path;
  try {
    return new URL(rel, window.location.href).href;
  } catch (e) {
    return rel;
  }
}

function getSha256ScriptUrl() {
  return getLabAssetAbsoluteUrl('/javascripts/lib/sha256.js');
}

/**
 * Build a blob:// worker URL with PoW inlined (importScripts loads CryptoJS).
 * Blob workers avoid path/404 issues on GitHub Pages and survive more reliably.
 */
function getMiningWorkerScriptUrl() {
  if (window.__labMiningWorkerBlobUrl) return window.__labMiningWorkerBlobUrl;
  const workerSource = `
var running = false, job = null, nonce = 0, totalIterations = 0, startTime = 0, timer = null, cryptoReady = false;
function clearTimer(){ if (timer != null) { clearTimeout(timer); timer = null; } }
function ensureCrypto(sha256Url){
  if (cryptoReady && typeof CryptoJS !== 'undefined') return Promise.resolve();
  return new Promise(function(resolve, reject){
    try {
      if (typeof CryptoJS === 'undefined') {
        if (!sha256Url) { reject(new Error('sha256Url required')); return; }
        importScripts(sha256Url);
      }
      if (typeof CryptoJS === 'undefined' || !CryptoJS.SHA256) { reject(new Error('CryptoJS unavailable')); return; }
      cryptoReady = true; resolve();
    } catch (e) { reject(e); }
  });
}
function sha256Hex(data){ return CryptoJS.SHA256(data).toString(); }
function canonicalizeObject(obj){
  if (Array.isArray(obj)) return obj.map(canonicalizeObject);
  if (obj !== null && typeof obj === 'object') {
    var sorted = {}, keys = Object.keys(obj).sort(), i;
    for (i = 0; i < keys.length; i++) sorted[keys[i]] = canonicalizeObject(obj[keys[i]]);
    return sorted;
  }
  return obj;
}
function isValidHash(hash, difficulty){
  if (difficulty == null) return false;
  if (typeof difficulty === 'number') difficulty = { leadingZeros: Math.max(1, Math.floor(difficulty)), secondaryHex: 'F' };
  if (typeof difficulty !== 'object') return false;
  var zeros = difficulty.leadingZeros != null ? difficulty.leadingZeros : 3, i;
  for (i = 0; i < zeros; i++) if (hash[i] !== '0') return false;
  if (difficulty.secondaryHex != null && String(difficulty.secondaryHex) !== '') {
    var nextChar = hash.charAt(zeros);
    if (nextChar && nextChar.toLowerCase() > String(difficulty.secondaryHex).toLowerCase()) return false;
  }
  return true;
}
function mineBatch(){
  if (!running || !job || !job.block) return;
  var block = job.block, difficulty = job.difficulty, batchSize = job.batchSize > 0 ? job.batchSize : 2000, i, hash;
  for (i = 0; i < batchSize; i++) {
    if (!running) return;
    hash = sha256Hex(JSON.stringify(canonicalizeObject({
      index: block.index, timestamp: block.timestamp, nonce: nonce, previousHash: block.previousHash,
      transactions: block.transactions, miner: block.miner, difficulty: block.difficulty, forkId: block.forkId
    })));
    if (isValidHash(hash, difficulty)) {
      block.hash = hash; block.nonce = nonce;
      self.postMessage({ type: 'found', gen: job.gen, block: block, hash: hash, nonce: nonce, totalIterations: totalIterations + 1, startTime: startTime });
      running = false; clearTimer(); return;
    }
    nonce++; totalIterations++;
  }
  var elapsed = Math.max(0.1, (Date.now() - startTime) / 1000);
  self.postMessage({ type: 'progress', gen: job.gen, nonce: nonce, totalIterations: totalIterations, hashrate: Math.max(1, Math.floor(totalIterations / elapsed)), startTime: startTime });
  if (!running) return;
  timer = setTimeout(mineBatch, job.delay != null ? job.delay : 0);
}
self.onmessage = function(e){
  var d = e.data || {}, cmd = d.command;
  if (cmd === 'init') {
    ensureCrypto(d.sha256Url).then(function(){ self.postMessage({ type: 'ready' }); })
      .catch(function(err){ self.postMessage({ type: 'error', message: (err && err.message) || String(err) }); });
    return;
  }
  if (cmd === 'start') {
    ensureCrypto(d.sha256Url).then(function(){
      clearTimer(); running = true;
      job = { gen: d.gen, block: d.block, difficulty: d.difficulty, delay: d.delay != null ? d.delay : 0, batchSize: d.batchSize != null ? d.batchSize : 2000 };
      nonce = d.nonce || 0; totalIterations = d.totalIterations || 0; startTime = d.startTime || Date.now();
      mineBatch();
    }).catch(function(err){ self.postMessage({ type: 'error', message: (err && err.message) || String(err) }); });
    return;
  }
  if (cmd === 'setPace') {
    if (job) { if (d.delay != null) job.delay = d.delay; if (d.batchSize != null) job.batchSize = d.batchSize; }
    return;
  }
  if (cmd === 'stop') { running = false; clearTimer(); job = null; }
};
`;
  const blob = new Blob([workerSource], { type: 'application/javascript' });
  window.__labMiningWorkerBlobUrl = URL.createObjectURL(blob);
  return window.__labMiningWorkerBlobUrl;
}

/** True when we can mine fully inside the worker (no custom student validator). */
function canUseWorkerMining() {
  if (miningWorkerFailed) return false;
  if (window.customValidator && window.customValidator._broken) return false;
  // Default validator is fine in the worker; student-edited validators stay on main thread
  if (window.__labValidatorIsCustom) return false;
  return true;
}

function miningPaceForVisibility() {
  const hidden = typeof document !== 'undefined' && document.hidden;
  // Background: max throughput in the worker. Foreground: honor CPU slider.
  return {
    delay: hidden ? 0 : getMineCpuDelay(),
    batchSize: hidden ? 8000 : 2000
  };
}

function ensureMiningWorker() {
  if (miningWorkerFailed) return null;
  if (miningWorker) return miningWorker;
  try {
    miningWorker = new Worker(getMiningWorkerScriptUrl());
  } catch (e) {
    console.warn('Mining worker unavailable, falling back to main-thread mining', e);
    miningWorkerFailed = true;
    miningWorker = null;
    return null;
  }
  miningWorker.onmessage = handleMiningWorkerMessage;
  miningWorker.onerror = function (err) {
    console.error('Mining worker error', err && err.message, err && err.filename, err && err.lineno);
    try { miningWorker.terminate(); } catch (e) {}
    miningWorker = null;
    miningWorkerReady = false;
    miningWorkerFailed = true; // do not tight-loop recreating a broken worker
    if (isMining && !networkPaused && currentMiningBlock) {
      mineBlockOnMainThread(currentMiningBlock, lastKnownAdminSettings);
    } else if (isMining && !networkPaused && window.lastMiningIntent) {
      setTimeout(function () {
        if (isMining && !networkPaused) fetchDataAndMine();
      }, 100);
    }
  };
  try {
    miningWorker.postMessage({ command: 'init', sha256Url: getSha256ScriptUrl() });
  } catch (e) {
    miningWorkerFailed = true;
    try { miningWorker.terminate(); } catch (err) {}
    miningWorker = null;
    return null;
  }
  return miningWorker;
}

function handleMiningWorkerMessage(ev) {
  const data = ev && ev.data;
  if (!data || !data.type) return;

  if (data.type === 'ready') {
    miningWorkerReady = true;
    return;
  }

  if (data.type === 'error') {
    console.error('Mining worker:', data.message);
    // Recover on main thread if worker crypto failed — once, not in a recreate loop
    miningWorkerFailed = true;
    try { if (miningWorker) miningWorker.terminate(); } catch (e) {}
    miningWorker = null;
    miningWorkerReady = false;
    if (isMining && !networkPaused && currentMiningBlock) {
      mineBlockOnMainThread(currentMiningBlock, lastKnownAdminSettings);
    }
    return;
  }

  if (data.gen != null && data.gen !== miningJobGen) {
    // Stale job after remine/stop
    return;
  }

  if (data.type === 'progress') {
    lastWorkerProgressAt = Date.now();
    const nonce = data.nonce || 0;
    const hashrate = data.hashrate || 0;
    try {
      const nc = document.getElementById('nonceCount');
      if (nc) nc.textContent = Number(nonce).toLocaleString();
      const ch = document.getElementById('currentHashrate');
      if (ch) ch.textContent = Number(hashrate).toLocaleString();
      const yh = document.getElementById('yourHashrate');
      if (yh) yh.textContent = Number(hashrate).toLocaleString() + ' H/s';
    } catch (e) {}

    const now = Date.now();
    if (now - lastHashrateEmitAt > 2000) {
      lastHashrateEmitAt = now;
      emitHashrate(hashrate);
    }
    return;
  }

  if (data.type === 'found') {
    lastWorkerProgressAt = Date.now();
    if (!isMining || networkPaused) return;
    const block = data.block;
    if (!block || !block.hash) return;

    if (isColluding) {
      collusionTipHash = block.hash;
      collusionHeight = (block.index != null ? block.index : collusionHeight) + 1;
      collusionTransactions = [];
    }

    seenBlocks.add(block.hash);
    pruneLocalMempool(block);

    if (isNewForkId(block.forkId)) {
      noteNewForkBlock(block);
    } else if (
      pendingForkHeight != null &&
      block.index != null &&
      Number(block.index) >= Number(pendingForkHeight)
    ) {
      noteClassicForkBlock(block);
    }

    submitMinedBlock(block, data.startTime || Date.now(), data.totalIterations || 0);

    // Continue at most one block ahead of hub confirmation on the classic main path.
    // NEW hard-fork side is orphaned by design and may lead the classic tip.
    if (!isMining || networkPaused) return;
    const capClassic = myForkChoice !== 'new';
    const foundIndex = block.index != null ? Number(block.index) : 0;
    if (capClassic && foundIndex >= hubConfirmedHeight + 1) {
      currentMiningBlock = null;
      showWaitingForHub(foundIndex);
      return;
    }
    const nextTmpl = getMiningTemplate();
    if (!nextTmpl || nextTmpl.waitForHub) {
      currentMiningBlock = null;
      showWaitingForHub((nextTmpl && nextTmpl.waitingOn) || foundIndex);
      return;
    }
    if (
      capClassic &&
      nextTmpl.index != null &&
      Number(nextTmpl.index) > hubConfirmedHeight + 1
    ) {
      currentMiningBlock = null;
      showWaitingForHub(hubConfirmedHeight + 1);
      return;
    }
    clearWaitingForHub();
    const nextBlock = {
      index: nextTmpl.index,
      timestamp: Date.now(),
      nonce: 0,
      previousHash: nextTmpl.previousHash,
      transactions: mempoolForNextBlock(),
      miner: userId,
      difficulty: getMiningDifficulty(),
      hash: '',
      forkId: nextTmpl.forkId
    };
    currentMiningBlock = nextBlock;
    updateMiningActivityUi(nextBlock.index);
    if (net) {
      net.send('mining-on-block', {
        blockHash: nextBlock.previousHash,
        minerAddress: userId
      });
    }
    startWorkerMiningJob(nextBlock);
  }
}

function emitHashrate(hashrate) {
  if (net) {
    net.send('hashrate-update', {
      userId: userId,
      hashrate: hashrate
    });
  } else if (typeof socket !== 'undefined' && socket) {
    socket.emit('hashrate-update', {
      sessionId: sessionId,
      hashrate: hashrate
    });
  }
}

function updateMiningActivityUi(blockIndex) {
  const label = blockIndex != null ? (' (Block #' + blockIndex + ')') : '';
  $('#miningActivity').html(
    '<div class="alert alert-info">' +
      '<p><strong>Mining in progress' + label + '…</strong></p>' +
      '<p>Nonce attempts: <span id="nonceCount">0</span></p>' +
      '<p>Current hashrate: <span id="currentHashrate">0</span> H/s</p>' +
      '<p class="small text-muted" id="bgMineNote" style="margin-top:6px;">Mining runs in a Web Worker so it continues if you switch apps/tabs. On phones, keep the screen on (or disable battery optimization for the browser) for best results.</p>' +
      '<div class="progress" style="margin-top: 10px;">' +
        '<div id="miningProgress" class="progress-bar progress-bar-striped active" style="width: 100%"></div>' +
      '</div>' +
    '</div>'
  );
}

function startWorkerMiningJob(block) {
  if (!isMining || networkPaused || !block) return;
  // Drop jobs that raced ahead of the hub (stale optimistic template)
  if (
    !isColluding &&
    myForkChoice !== 'new' &&
    block.index != null &&
    Number(block.index) > hubConfirmedHeight + 1
  ) {
    debugWarn('Skip mining job ahead of hub', block.index, 'hub', hubConfirmedHeight);
    showWaitingForHub(hubConfirmedHeight + 1);
    return;
  }
  if (submittedSlots.has(blockSlotKey(block))) {
    showWaitingForHub(block.index);
    return;
  }
  clearWaitingForHub();
  const worker = ensureMiningWorker();
  if (!worker) {
    mineBlockOnMainThread(block, lastKnownAdminSettings);
    return;
  }
  miningJobGen++;
  const gen = miningJobGen;
  currentMiningBlock = block;
  const pace = miningPaceForVisibility();
  lastWorkerProgressAt = Date.now();
  // Ensure difficulty object is the hub shape the worker understands
  const diff = block.difficulty || getMiningDifficulty();
  const difficulty = {
    leadingZeros:
      (diff && (diff.leadingZeros != null ? diff.leadingZeros : diff.leading)) != null
        ? (diff.leadingZeros != null ? diff.leadingZeros : diff.leading)
        : 1,
    secondaryHex:
      diff && diff.secondaryHex != null
        ? String(diff.secondaryHex)
        : (diff && diff.secondary != null ? Number(diff.secondary).toString(16) : 'f')
  };
  worker.postMessage({
    command: 'start',
    gen: gen,
    sha256Url: getSha256ScriptUrl(),
    block: JSON.parse(JSON.stringify(Object.assign({}, block, { difficulty: difficulty }))),
    difficulty: difficulty,
    delay: pace.delay,
    batchSize: pace.batchSize,
    nonce: 0,
    totalIterations: 0,
    startTime: Date.now()
  });
}

function syncMiningWorkerPace() {
  if (!miningWorker || !isMining) return;
  const pace = miningPaceForVisibility();
  try {
    miningWorker.postMessage({
      command: 'setPace',
      delay: pace.delay,
      batchSize: pace.batchSize
    });
  } catch (e) {}
}

async function requestMiningWakeLock() {
  try {
    if (typeof navigator === 'undefined' || !navigator.wakeLock || !navigator.wakeLock.request) {
      return;
    }
    if (miningWakeLock) return;
    miningWakeLock = await navigator.wakeLock.request('screen');
    miningWakeLock.addEventListener('release', function () {
      miningWakeLock = null;
    });
  } catch (e) {
    // Browser may deny when tab is hidden or unsupported
    miningWakeLock = null;
  }
}

function releaseMiningWakeLock() {
  if (!miningWakeLock) return;
  try { miningWakeLock.release(); } catch (e) {}
  miningWakeLock = null;
}

function startMiningKeepalive() {
  if (miningKeepaliveTimer) return;
  miningKeepaliveTimer = setInterval(function () {
    if (!window.lastMiningIntent || networkPaused) return;
    // If we intended to mine but aren't, restart
    if (!isMining) {
      startMining();
      return;
    }
    // Worker/main loop went silent (tab freeze / process kill) — re-kick
    // Waiting for hub on purpose — do not remine the same height (that minted
    // several Block #N siblings from one miner). Re-broadcast the same hash.
    if (waitingForHubSince) {
      if (Date.now() - waitingForHubSince > 12000 && lastSubmittedBlock && net) {
        debugWarn('Re-broadcasting submitted block, not remaking the height', lastSubmittedBlock.index);
        net.send('block-submitted', { block: lastSubmittedBlock, minerId: userId });
        waitingForHubSince = Date.now();
      }
      return;
    }
    if (Date.now() - lastWorkerProgressAt > 12000) {
      debugWarn('Mining silent — restarting job');
      // Allow another worker attempt after a long freeze (mobile OS kill)
      if (miningWorkerFailed && Date.now() - lastWorkerProgressAt > 30000) {
        miningWorkerFailed = false;
      }
      // Prefer re-posting work over terminate+recreate (cheaper, fewer 404 races)
      if (miningWorker && currentMiningBlock && !miningWorkerFailed) {
        try {
          startWorkerMiningJob(currentMiningBlock);
        } catch (e) {
          try { miningWorker.terminate(); } catch (err) {}
          miningWorker = null;
          miningWorkerReady = false;
          miningJobGen++;
          fetchDataAndMine();
        }
      } else if (Date.now() - lastRemineAt >= 500) {
        try {
          if (miningWorker) {
            miningWorker.postMessage({ command: 'stop' });
            miningWorker.terminate();
          }
        } catch (e) {}
        miningWorker = null;
        miningWorkerReady = false;
        lastRemineAt = Date.now();
        miningJobGen++;
        fetchDataAndMine();
      }
    } else {
      syncMiningWorkerPace();
    }
    // Re-request wake lock if it was released (common when screen turns off then on)
    if (document && !document.hidden) {
      requestMiningWakeLock();
    }
  }, 3000);
}

function stopMiningKeepalive() {
  if (miningKeepaliveTimer) {
    clearInterval(miningKeepaliveTimer);
    miningKeepaliveTimer = null;
  }
}

/** Install once: keep mining across tab blur / mobile background / bfcache. */
function setupBackgroundMiningGuards() {
  if (window.__labBgMineGuards) return;
  window.__labBgMineGuards = true;

  document.addEventListener('visibilitychange', function () {
    syncMiningWorkerPace();
    if (!document.hidden) {
      if (window.lastMiningIntent && !networkPaused) {
        if (!isMining) startMining();
        else {
          // Nudge worker after returning to foreground
          if (Date.now() - lastWorkerProgressAt > 2000) {
            remineOnCanonicalTip();
          }
          requestMiningWakeLock();
        }
      }
    } else if (isMining) {
      // Backgrounded: switch to max-pace worker hashing
      syncMiningWorkerPace();
    }
  });

  window.addEventListener('pageshow', function () {
    if (window.lastMiningIntent && !networkPaused) {
      if (!isMining) startMining();
      else if (Date.now() - lastWorkerProgressAt > 2000) remineOnCanonicalTip();
      requestMiningWakeLock();
    }
  });

  window.addEventListener('focus', function () {
    if (window.lastMiningIntent && !networkPaused && !isMining) {
      startMining();
    }
  });

  // Page Lifecycle API (Chrome): resume after freeze
  document.addEventListener('resume', function () {
    if (window.lastMiningIntent && !networkPaused) {
      if (!isMining) startMining();
      else remineOnCanonicalTip();
      requestMiningWakeLock();
    }
  });
}

/** Soft remine after mempool updates — debounced so a tx doesn't thrash mid-submit. */
function scheduleRemineForMempool() {
  if (!isMining || isColluding || networkPaused) return;
  if (remineTxTimer) clearTimeout(remineTxTimer);
  remineTxTimer = setTimeout(function () {
    remineTxTimer = null;
    remineOnCanonicalTip();
  }, 350);
}

function txKey(tx) {
  if (!tx) return '';
  if (tx.id) return String(tx.id);
  return String(tx.from || '') + ':' + String(tx.to || '') + ':' + String(tx.timestamp || '');
}

/** Keys of transfers already present on a chain (or a single block). */
function confirmedTxKeysFromChain(chainOrBlocks) {
  const ids = new Set();
  const blocks = Array.isArray(chainOrBlocks) ? chainOrBlocks : [];
  blocks.forEach(function (b) {
    const txs = (b && Array.isArray(b.transactions)) ? b.transactions : [];
    txs.forEach(function (t) {
      const k = txKey(t);
      if (k) ids.add(k);
    });
  });
  return ids;
}

/**
 * Drop confirmed transfers from the local mempool mirror.
 * Always re-filter against the local chain so a stale hub pending list can't resurrect them.
 */
function pruneLocalMempool(extraBlocks) {
  const confirmed = confirmedTxKeysFromChain(window.lastRelayedChain || []);
  if (extraBlocks) {
    confirmedTxKeysFromChain(Array.isArray(extraBlocks) ? extraBlocks : [extraBlocks])
      .forEach(function (k) { confirmed.add(k); });
  }
  if (!confirmed.size) return confirmed;
  localPendingTxs = localPendingTxs.filter(function (t) {
    return !confirmed.has(txKey(t));
  });
  return confirmed;
}

/** Mempool slice safe to mine — never re-include confirmed transfers. */
function mempoolForNextBlock() {
  pruneLocalMempool();
  return localPendingTxs.slice(0, 20);
}

function pushOptimisticTip(block) {
  if (!block || !block.hash) return;
  // Never race more than one unconfirmed block ahead of the hub (classic main).
  // Unbounded optimistic tips were sending mobile miners to index 20+ while hub sat at 2.
  if (block.index != null && Number(block.index) > hubConfirmedHeight + 1) {
    return;
  }
  if (!window.lastRelayedChain) window.lastRelayedChain = [];
  const tip = window.lastRelayedChain[window.lastRelayedChain.length - 1];
  if (tip && tip.hash === block.hash) return;
  if (!tip || tip.hash === block.previousHash) {
    window.lastRelayedChain.push(block);
  }
}

/**
 * Replace local chain with the hub's canonical chain and remine if the tip moved
 * away from what we were hashing.
 * @returns {boolean} whether the tip hash changed
 */
function applyCanonicalChain(chain, opts) {
  opts = opts || {};
  if (!chain || !Array.isArray(chain) || chain.length === 0) return false;

  const oldTip = window.lastRelayedChain && window.lastRelayedChain.length
    ? window.lastRelayedChain[window.lastRelayedChain.length - 1]
    : null;
  const newTip = chain[chain.length - 1];
  const tipChanged = !oldTip || !newTip || oldTip.hash !== newTip.hash;

  // Preserve our previous main blocks as known orphans if the hub tip switched sides
  // (hard fork / reorg) so sticky classic/NEW tips are not wiped.
  const prevMain = (window.lastRelayedChain || []).slice();
  window.lastRelayedChain = chain.slice();
  chain.forEach(function (b) {
    if (b && b.hash) seenBlocks.add(b.hash);
  });
  if (prevMain.length) {
    const mainHashes = new Set(chain.map(function (b) { return b && b.hash; }));
    const displaced = prevMain.filter(function (b) {
      return b && b.hash && !mainHashes.has(b.hash);
    });
    if (displaced.length) mergeKnownOrphans(displaced);
    displaced.forEach(function (b) {
      if (isNewForkId(b.forkId)) noteNewForkBlock(b);
      else if (isClassicForkId(b.forkId)) noteClassicForkBlock(b);
    });
  }

  try {
    const parts = opts.participants || [];
    // Merge orphans BEFORE rendering Shared Network (was painting empty orphans first)
    if (opts.orphans) {
      mergeKnownOrphans(opts.orphans);
    }
    // Absorb any NEW/classic side tips from the new main for sticky tracking
    chain.forEach(function (b) {
      if (!b) return;
      if (isNewForkId(b.forkId)) noteNewForkBlock(b);
      else if (
        pendingForkHeight != null &&
        b.index != null &&
        Number(b.index) >= Number(pendingForkHeight) &&
        isClassicForkId(b.forkId)
      ) {
        noteClassicForkBlock(b);
      }
    });
    if (opts.pendingTransactions) {
      localPendingTxs = opts.pendingTransactions.slice();
    }
    // Strip anything already on the new chain (hub list can lag under MQTT races)
    pruneLocalMempool();
    updatePendingTransactions({
      pendingTransactions: localPendingTxs,
      participants: parts
    });
    if (opts.networkStats || parts.length) {
      updateNetworkStats({
        networkStats: opts.networkStats || {},
        participants: parts
      });
    }
    if (parts.length) updateParticipantList({ participants: parts });
    const me = parts.find(function (p) {
      return p.address === userId || p.userId === userId;
    });
    if (me) {
      if (me.balance !== undefined) $('#yourBalance').text(me.balance);
      if (me.blocksMined !== undefined) $('#blocksMined').text(me.blocksMined);
      else if (me.minedBlocks !== undefined) $('#blocksMined').text(me.minedBlocks);
    }
    applyMyBalanceFromParticipants(parts);
    // Personal view = own tip path (fork-aware); Shared Network = main + side chains
    updateParticipantBlockchainView({ chain: getPersonalChainBlocks() }, parts);
    refreshSharedNetworkView(parts);
  } catch (e) {
    console.error('Error applying canonical chain UI', e);
  }

  if (newTip) {
    const h = (newTip.index != null)
      ? newTip.index
      : Math.max(0, window.lastRelayedChain.length - 1);
    $('#blockHeight').text(h);
  }

  // Track hub-confirmed tip height so optimistic mining cannot race dozens of blocks ahead
  if (newTip && newTip.index != null) {
    hubConfirmedHeight = Math.max(hubConfirmedHeight, Number(newTip.index) || 0);
  } else if (chain.length) {
    hubConfirmedHeight = Math.max(hubConfirmedHeight, chain.length - 1);
  }
  if (waitingForHubIndex != null && hubConfirmedHeight >= waitingForHubIndex) {
    clearWaitingForHub();
  }

  // Always remine after a hub sync while mining — cancels private optimistic forks
  // (mempool already pruned so the next template cannot re-include confirmed txs)
  if (opts.remine !== false && isMining) {
    remineOnCanonicalTip({ force: true });
  }

  return tipChanged;
}

function isNewForkId(fid) {
  return fid === 'new' || fid === 'NEW';
}

function isClassicForkId(fid) {
  return !fid || fid === 'classic' || fid === 'CLASSIC';
}

function mergeKnownOrphans(list) {
  if (!Array.isArray(list)) return;
  const byHash = new Map();
  (lastKnownOrphans || []).forEach(function (b) {
    if (b && b.hash) byHash.set(b.hash, b);
  });
  list.forEach(function (b) {
    if (b && b.hash) byHash.set(b.hash, b);
  });
  // Drop anything that is now on the main relayed chain
  const main = new Set((window.lastRelayedChain || []).map(function (b) { return b && b.hash; }));
  lastKnownOrphans = Array.from(byHash.values()).filter(function (b) {
    return b && b.hash && !main.has(b.hash);
  });
  // Keep NEW-side tip sticky for miners that chose the new chain
  refreshLocalNewForkTip();
}

/** Orphans for Shared Network UI (includes sticky local NEW / classic tips if not on main). */
function getDisplayOrphans() {
  const byHash = new Map();
  (lastKnownOrphans || []).forEach(function (b) {
    if (b && b.hash) byHash.set(b.hash, b);
  });
  if (localNewForkTip && localNewForkTip.block && localNewForkTip.block.hash) {
    byHash.set(localNewForkTip.block.hash, localNewForkTip.block);
  }
  if (localClassicForkTip && localClassicForkTip.block && localClassicForkTip.block.hash) {
    byHash.set(localClassicForkTip.block.hash, localClassicForkTip.block);
  }
  // Include competing fork blocks (NEW or classic) that aren't on main
  const main = new Set((window.lastRelayedChain || []).map(function (b) { return b && b.hash; }));
  const all = collectKnownBlocks();
  all.forEach(function (b, hash) {
    if (!b || !hash || main.has(hash)) return;
    if (isNewForkId(b.forkId) || isClassicForkId(b.forkId)) {
      byHash.set(hash, b);
    }
  });
  return Array.from(byHash.values()).filter(function (b) {
    return b && b.hash && !main.has(b.hash);
  });
}

/** Remember roster for name lookup on later paints (don't pass [] and wipe names). */
function rememberParticipants(parts) {
  if (!Array.isArray(parts) || !parts.length) return lastKnownParticipants;
  // Merge by userId so a partial roster doesn't drop names we already know
  const byId = new Map();
  (lastKnownParticipants || []).forEach(function (p) {
    const id = p && (p.userId || p.address || p.id);
    if (id) byId.set(String(id), p);
  });
  parts.forEach(function (p) {
    if (!p) return;
    const id = p.userId || p.address || p.id;
    if (!id) return;
    const prev = byId.get(String(id)) || {};
    const merged = Object.assign({}, prev, p);
    // Never clobber a known display name with null/empty from a sparse MQTT payload
    const prevName = (prev.displayName || prev.name || '').trim();
    const nextName = (p.displayName || p.name || '').trim();
    if (!nextName && prevName) {
      merged.name = prev.name || prevName;
      merged.displayName = prev.displayName || prevName;
    } else if (nextName) {
      merged.name = p.name || nextName;
      merged.displayName = p.displayName || nextName;
    }
    byId.set(String(id), merged);
  });
  lastKnownParticipants = Array.from(byId.values());
  return lastKnownParticipants;
}

/** Redraw Shared Network tab: hub main chain + orphans / competing forks. */
function refreshSharedNetworkView(participants) {
  const parts = rememberParticipants(participants);
  try {
    updateNetworkBlockchainView(
      window.lastRelayedChain || [],
      getDisplayOrphans(),
      parts
    );
  } catch (e) {
    console.warn('refreshSharedNetworkView', e);
  }
}

/** Remember / refresh the best NEW hard-fork tip we know about. */
function noteNewForkBlock(block) {
  if (!block || !block.hash || !isNewForkId(block.forkId)) return;
  mergeKnownOrphans([block]);
  if (
    !localNewForkTip ||
    (block.index != null && block.index > localNewForkTip.index) ||
    (block.index === localNewForkTip.index && block.hash !== localNewForkTip.hash)
  ) {
    // Prefer higher index; same index keeps existing unless we don't have one
    if (!localNewForkTip || block.index > localNewForkTip.index) {
      localNewForkTip = {
        hash: block.hash,
        index: block.index != null ? block.index : 0,
        previousHash: block.previousHash,
        block: block
      };
    }
  }
  refreshLocalNewForkTip();
  // Keep Shared Network live when orphans arrive (even if user is on Personal tab)
  refreshSharedNetworkView();
}

/** Remember / refresh the best CLASSIC post-activation tip (sticky for classic miners). */
function noteClassicForkBlock(block) {
  if (!block || !block.hash || !isClassicForkId(block.forkId)) return;
  // Only sticky after activation — pre-activation is always the shared main chain
  if (
    pendingForkHeight != null &&
    block.index != null &&
    Number(block.index) < Number(pendingForkHeight)
  ) {
    return;
  }
  // If not on main, keep as orphan so Shared Network shows the classic side
  const mainHashes = new Set((window.lastRelayedChain || []).map(function (b) {
    return b && b.hash;
  }));
  if (block.hash && !mainHashes.has(block.hash)) {
    mergeKnownOrphans([block]);
  }
  if (!localClassicForkTip || (block.index != null && block.index > localClassicForkTip.index)) {
    localClassicForkTip = {
      hash: block.hash,
      index: block.index != null ? block.index : 0,
      previousHash: block.previousHash,
      block: block
    };
  }
  refreshLocalClassicForkTip();
  refreshSharedNetworkView();
}

function refreshLocalNewForkTip() {
  const all = collectKnownBlocks();
  const newBlocks = Array.from(all.values()).filter(function (b) {
    return b && isNewForkId(b.forkId);
  });
  if (!newBlocks.length) return;

  const tips = newBlocks.filter(function (b) {
    return !newBlocks.some(function (c) { return c.previousHash === b.hash; });
  });
  tips.sort(function (a, b) {
    return (b.index || 0) - (a.index || 0);
  });
  const best = tips[0] || newBlocks[newBlocks.length - 1];
  const bestIdx = best.index != null ? best.index : 0;
  const localIdx = localNewForkTip && localNewForkTip.index != null ? localNewForkTip.index : -1;

  // Keep local tip if we are ahead of hub knowledge (optimistic mining)
  if (localNewForkTip && localIdx > bestIdx) return;

  localNewForkTip = {
    hash: best.hash,
    index: bestIdx,
    previousHash: best.previousHash,
    block: best
  };
}

function refreshLocalClassicForkTip() {
  const act = pendingForkHeight != null ? Number(pendingForkHeight) : null;
  if (act == null) {
    localClassicForkTip = null;
    return;
  }
  const all = collectKnownBlocks();
  const classicBlocks = Array.from(all.values()).filter(function (b) {
    return (
      b &&
      isClassicForkId(b.forkId) &&
      b.index != null &&
      Number(b.index) >= act
    );
  });
  if (!classicBlocks.length) return;

  const tips = classicBlocks.filter(function (b) {
    return !classicBlocks.some(function (c) { return c.previousHash === b.hash; });
  });
  tips.sort(function (a, b) {
    return (b.index || 0) - (a.index || 0);
  });
  const best = tips[0] || classicBlocks[classicBlocks.length - 1];
  const bestIdx = best.index != null ? best.index : 0;
  const localIdx =
    localClassicForkTip && localClassicForkTip.index != null
      ? localClassicForkTip.index
      : -1;

  if (localClassicForkTip && localIdx > bestIdx) return;

  localClassicForkTip = {
    hash: best.hash,
    index: bestIdx,
    previousHash: best.previousHash,
    block: best
  };
}

function collectKnownBlocks() {
  const all = new Map();
  (window.lastRelayedChain || []).forEach(function (b) {
    if (b && b.hash) all.set(b.hash, b);
  });
  (lastKnownOrphans || []).forEach(function (b) {
    if (b && b.hash) all.set(b.hash, b);
  });
  if (localNewForkTip && localNewForkTip.block && localNewForkTip.block.hash) {
    all.set(localNewForkTip.block.hash, localNewForkTip.block);
  }
  if (localClassicForkTip && localClassicForkTip.block && localClassicForkTip.block.hash) {
    all.set(localClassicForkTip.block.hash, localClassicForkTip.block);
  }
  return all;
}

/**
 * Classic tip = sticky local classic post-act tip, else highest classic-compatible
 * block we know (main or orphans). Never returns a NEW block.
 */
function getClassicMiningTip(main) {
  main = main || window.lastRelayedChain || [];
  const act = pendingForkHeight != null ? Number(pendingForkHeight) : null;

  refreshLocalClassicForkTip();
  if (
    localClassicForkTip &&
    localClassicForkTip.hash &&
    localClassicForkTip.block &&
    isClassicForkId(localClassicForkTip.block.forkId)
  ) {
    return localClassicForkTip.block;
  }

  // Search all known blocks for highest classic tip (main + orphans)
  const all = collectKnownBlocks();
  let best = null;
  all.forEach(function (b) {
    if (!b || !b.hash) return;
    if (isNewForkId(b.forkId)) return;
    if (act != null && b.index != null && Number(b.index) >= act && isNewForkId(b.forkId)) {
      return;
    }
    if (!best || (b.index != null && b.index > (best.index || 0))) {
      best = b;
    }
  });
  if (best) return best;

  if (!main.length) return null;
  for (let i = main.length - 1; i >= 0; i--) {
    const b = main[i];
    if (!b) continue;
    if (act != null && b.index != null && b.index >= act && isNewForkId(b.forkId)) {
      continue; // skip NEW blocks that landed on "main" via longest-chain
    }
    return b;
  }
  return main[0];
}

/**
 * forkId is only non-classic at/after activation height.
 * Using 'new' before activation was causing races/orphans every block.
 */
function effectiveForkIdForIndex(index) {
  if (pendingForkHeight == null || index == null) return 'classic';
  if (Number(index) < Number(pendingForkHeight)) return 'classic';
  return myForkChoice === 'new' ? 'new' : 'classic';
}

/** True once the classic tip has reached the hard-fork activation parent. */
function hardForkActivatedOnChain() {
  if (pendingForkHeight == null) return false;
  const tip = getClassicMiningTip();
  if (!tip || tip.index == null) return false;
  return Number(tip.index) >= Number(pendingForkHeight) - 1;
}

/** Pick parent + index + forkId for the next block we mine. Stick to chosen side. */
function getMiningTemplate() {
  const main = window.lastRelayedChain || [];
  if (!main.length) return null;

  const act = pendingForkHeight != null ? Number(pendingForkHeight) : null;
  const classicTip = getClassicMiningTip(main);
  if (!classicTip) return null;

  // Classic miners (or no fork): extend the *hub-confirmed* tip only.
  // lastRelayedChain may include one optimistic local block; using that as
  // parent produced "working on #23" with no #22 while hashing was skipped.
  if (myForkChoice !== 'new' || act == null) {
    const hubTip = getHubConfirmedClassicTip(main) || classicTip;
    if (!hubTip) return null;
    const nextIndex = (hubTip.index != null ? Number(hubTip.index) : 0) + 1;
    const tail = main[main.length - 1];
    if (
      tail &&
      tail.hash &&
      tail.hash !== hubTip.hash &&
      tail.index != null &&
      Number(tail.index) >= nextIndex
    ) {
      return {
        waitForHub: true,
        waitingOn: nextIndex,
        previousHash: hubTip.hash,
        index: nextIndex,
        forkId: effectiveForkIdForIndex(nextIndex)
      };
    }
    return {
      previousHash: hubTip.hash,
      index: nextIndex,
      forkId: effectiveForkIdForIndex(nextIndex)
    };
  }

  // NEW miners before activation parent exists: still classic
  if ((classicTip.index != null ? classicTip.index : 0) < act - 1) {
    const index = (classicTip.index != null ? classicTip.index : 0) + 1;
    return {
      previousHash: classicTip.hash,
      index: index,
      forkId: 'classic'
    };
  }

  // Prefer sticky local NEW tip, then best known NEW tip from orphans/main
  refreshLocalNewForkTip();
  if (localNewForkTip && localNewForkTip.hash) {
    return {
      previousHash: localNewForkTip.hash,
      index: (localNewForkTip.index != null ? localNewForkTip.index : 0) + 1,
      forkId: 'new'
    };
  }

  const all = collectKnownBlocks();
  const newBlocks = Array.from(all.values()).filter(function (b) {
    return b && isNewForkId(b.forkId);
  });

  if (newBlocks.length > 0) {
    const tips = newBlocks.filter(function (b) {
      return !newBlocks.some(function (c) { return c.previousHash === b.hash; });
    });
    tips.sort(function (a, b) { return (b.index || 0) - (a.index || 0); });
    const best = tips[0] || newBlocks[newBlocks.length - 1];
    localNewForkTip = {
      hash: best.hash,
      index: best.index != null ? best.index : 0,
      previousHash: best.previousHash,
      block: best
    };
    return {
      previousHash: best.hash,
      index: (best.index != null ? best.index : 0) + 1,
      forkId: 'new'
    };
  }

  // First NEW block: parent must be classic block at height act-1
  let parent = null;
  for (let i = main.length - 1; i >= 0; i--) {
    if (main[i].index === act - 1 && isClassicForkId(main[i].forkId)) {
      parent = main[i];
      break;
    }
  }
  if (!parent) {
    for (let i = main.length - 1; i >= 0; i--) {
      if (main[i].index != null && main[i].index < act && isClassicForkId(main[i].forkId)) {
        parent = main[i];
        break;
      }
    }
  }
  if (!parent) parent = classicTip;
  const index = (parent.index != null ? parent.index : 0) + 1;
  return {
    previousHash: parent.hash,
    index: index,
    forkId: index >= act ? 'new' : 'classic'
  };
}

// Canonicalize object for consistent hashing (sorted keys)
function canonicalizeObject(obj) {
  if (Array.isArray(obj)) {
    return obj.map(item => canonicalizeObject(item));
  } else if (obj !== null && typeof obj === 'object') {
    const sorted = {};
    Object.keys(obj).sort().forEach(key => {
      sorted[key] = canonicalizeObject(obj[key]);
    });
    return sorted;
  }
  return obj;
}

// Require CryptoJS for hashing - fail loudly if not available
if (typeof CryptoJS === 'undefined') {
  throw new Error('CryptoJS library is required but not loaded. Please ensure sha256.js is included in the page.');
}

// Define the sha256 hash function using CryptoJS
window.sha256 = function(data) {
  if (typeof CryptoJS === 'undefined') {
    throw new Error('CryptoJS became unavailable during execution. This should not happen.');
  }
  return CryptoJS.SHA256(data).toString();
};

// Apply participant's custom validator code to their local node
function applyCustomValidator(code) {
  if (window.ValidatorBridge) {
    const result = ValidatorBridge.applyToWindow(code, originalValidatorCode);
    if (result.skip) return true;
    return result.ok ? true : result.error;
  }
  if (code && typeof code === 'object' && typeof code.value === 'string') {
    code = code.value;
  }
  if (typeof code !== 'string') {
    return 'Validator code must be a string';
  }
  if (code.includes('WALLET DOUBLE SPEND SCRIPT')) {
    return true;
  }
  if (!code.trim()) {
    try { delete window.customValidator; } catch (e) { window.customValidator = null; }
    window.__labValidatorIsCustom = false;
    return true;
  }

  try {
    let browserCode = code
      .replace(/const crypto = require\(['"]crypto['"]\);/g, `
        const crypto = {
          createHash: function() {
            return {
              data: '',
              update: function(d) { this.data += (typeof d === 'string' ? d : JSON.stringify(d)); return this; },
              digest: function() { return window.sha256(this.data); }
            };
          }
        };
      `)
      .replace(/module\.exports\s*=\s*BlockValidator;?/g, '')
      + '\nreturn new BlockValidator();';
    
    window.customValidator = new Function(browserCode)();
    const orig = (typeof originalValidatorCode === 'string') ? originalValidatorCode.trim() : '';
    window.__labValidatorIsCustom = !!(orig && code.trim() !== orig);
    return true;
  } catch (e) {
    return e.message;
  }
}

// Toast notification function (non-intrusive bubble at top)
function showToastNotification(message, type = 'info') {
  // Remove existing toast if any
  $('#toastNotification').remove();
  
  const bgColor = type === 'success' ? '#28a745' : type === 'error' ? '#dc3545' : '#17a2b8';
  
  const toast = $(`
    <div id="toastNotification" style="
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${bgColor};
      color: white;
      padding: 15px 25px;
      border-radius: 5px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.2);
      z-index: 9999;
      max-width: 400px;
      word-wrap: break-word;
      animation: slideIn 0.3s ease-out;
    ">
      ${message}
    </div>
  `);
  
  $('body').append(toast);
  
  // Auto-dismiss after 4 seconds
  setTimeout(function() {
    toast.fadeOut(300, function() { $(this).remove(); });
  }, 4000);
}

// Add CSS animation for toast
if (!$('#toastStyles').length) {
  $('<style id="toastStyles">@keyframes slideIn { from { transform: translateX(450px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }</style>').appendTo('head');
}

/**
 * Resolve this tab's miner identity.
 * Prefer ?uid= (Open Test Miner Tab) so each test tab is unique; keep that
 * id in sessionStorage so refresh of THIS tab keeps it without clobbering
 * other tabs that share localStorage.
 */
function resolveParticipantUserId(sessionId) {
  let fromQuery = '';
  try {
    const params = new URLSearchParams(window.location.search || '');
    fromQuery = (params.get('uid') || params.get('userId') || '').trim();
  } catch (e) {}

  if (fromQuery) {
    try { sessionStorage.setItem('labUserId_' + sessionId, fromQuery); } catch (e) {}
    return fromQuery;
  }

  try {
    const fromTab = sessionStorage.getItem('labUserId_' + sessionId);
    if (fromTab) return fromTab;
  } catch (e) {}

  let fromLocal = localStorage.getItem('userId_' + sessionId);
  if (!fromLocal) {
    fromLocal = 'user_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('userId_' + sessionId, fromLocal);
  }
  try { sessionStorage.setItem('labUserId_' + sessionId, fromLocal); } catch (e) {}
  return fromLocal;
}

$(document).ready(function() {
  sessionId = (window.LabPaths && LabPaths.getSessionIdFromLocation()) || '';
  restoreForkChoiceFromSession();

  // Set address and session code as early as possible from localStorage or URL to avoid "Loading..." flash/stuck
  const earlyUserId = resolveParticipantUserId(sessionId);
  userId = earlyUserId;
  $('#yourAddress').text(userId);

  const earlyJoinCode = localStorage.getItem('joinCode_' + sessionId) || sessionId;
  $('#sessionCode').text(earlyJoinCode);
  $('#sessionCode').after('<span style="display: block; margin-top: 10px; text-align: center;"><strong>Your Role: </strong><span class="label label-success" style="font-size: 1em;">Miner</span></span>');

  // Early defaults for stats to avoid loading look
  $('#blockHeight').text('0');
  $('#participantCount').text('0');
  $('#totalHashrate').text('0 H/s');
  $('#difficultyLevel').text('N/A');
  $('#yourBalance').text('0');
  $('#blocksMined').text('0');
  $('#yourHashrate').text('0 H/s');

  // Always client-relay mode (admin-hosted by default; may switch to Full P2P via admin settings)
  networkMode = localStorage.getItem('networkingMode_' + earlyJoinCode) || 'admin-relay';
  console.log('[BlockchainLab Participant] Networking mode:', networkMode, 'room:', sessionId);

  initClientSideNetworkingForParticipant(networkMode);

  // Note about relay
  $('#blockchainView').prepend('<div class="alert alert-info small" id="networkModeNote" style="margin-bottom:8px">Connecting to instructor hub…</div>');
  $('#blockchainView').prepend('<div class="alert alert-warning small" id="connectionStatusNote" style="margin-bottom:8px; display:none;"></div>');

  // Block invalid / inactive session codes (direct URL protection)
  if (window.LabSessionProbe && typeof LabSessionProbe.requireActiveSession === 'function') {
    LabSessionProbe.requireActiveSession(earlyJoinCode).catch(function () {
      /* redirect handled by probe */
    });
  }

  // If hub is slow but session was verified on landing, seed local genesis so mining can continue
  setTimeout(function () {
    if (window.lastRelayedChain && window.lastRelayedChain.length > 0) return;
    var verified = window.LabSessionProbe && LabSessionProbe.wasRecentlyVerified(earlyJoinCode);
    if (!verified) return;
    seedLocalGenesisChain();
    $('#connectionStatusNote').show().html(
      'No response from instructor yet. Mining uses a local genesis tip — keep the <strong>admin tab open</strong> on the same lab URL. ' +
      'On phones, use the QR/share link from the admin page (GitHub Pages), not localhost.'
    );
    showToastNotification('Waiting for instructor hub — seeded local genesis so you can mine', 'warning');
  }, 2500);

  loadValidatorCode();

  if (window.ValidatorBridge && typeof ValidatorBridge.listen === 'function') {
    ValidatorBridge.listen(function (msg) {
      if (!msg) return;
      if (msg.sessionId && sessionId && String(msg.sessionId).toUpperCase() !== String(sessionId).toUpperCase()) return;
      if (msg.type === 'reset') {
        var src = (typeof originalValidatorCode === 'string') ? originalValidatorCode : '';
        $('#validatorCodeEditor').val(src);
        applyCustomValidator(src);
        return;
      }
      if (msg.type === 'apply' && msg.code) {
        $('#validatorCodeEditor').val(msg.code);
        applyCustomValidator(msg.code);
      }
    });
  }
  
  // Set up event handlers
  setupEventHandlers();
  
  // Note: Auto-refresh now happens via WebSocket block-broadcast events only
  // This eliminates constant polling and reduces server load
  
  
  // Initialize CPU usage display to match default
  $('#cpuUsage').val(cpuLimitPercent);
  $('#cpuUsageValue').text(cpuLimitPercent);

  // Display user info (already set above)
  // $('#yourAddress').text(userId);

  // Add fork control panel placeholder
  $('#blockchainView').before(`
    <div id="forkControlPanel" style="display:none; margin-bottom: 15px; padding: 15px; background-color: #fff8e1; border: 1px solid #ffecb3; border-radius: 4px;">
      <h4><i class="glyphicon glyphicon-random"></i> Fork Control</h4>
      <p>A network fork is active. Choose which chain to follow:</p>
      <div class="btn-group" role="group">
        <button type="button" id="btnFollowClassic" class="btn btn-primary">Classic Chain</button>
        <button type="button" id="btnFollowNew" class="btn btn-default">New Chain</button>
      </div>
    </div>
  `);

  // No server polling in client-relay mode

});

// Legacy initSocket removed (client-relay only)
let socket = null; // ensure no ReferenceError from any remaining legacy paths
  
  function handleGossipBlock(block, minerId) {
    if (minerId === userId) return; // Ignore our own block
    if (seenBlocks.has(block.hash)) return; // Deduplicate! Stop infinite gossip loop
    
    seenBlocks.add(block.hash);
    debugLog(`Received gossip block from ${minerId}: ${block.hash.substring(0, 16)}... Evaluating.`);

    // Track validator acceptance (broken validator = rejects everything)
    let validatorAccepts = true;
    let validatorReason = null;

    // Run custom validator if available
    if (window.customValidator) {
      if (window.customValidator._broken) {
        validatorAccepts = false;
        validatorReason = '❌ Broken validator';
        showToastNotification(`${validatorReason} rejected block #${block.index}`, 'error');
      } else {
        try {
          // Validate the hash matches the data
          const hashCheck = window.customValidator.validateBlockHash(block);
          if (!hashCheck) {
            validatorAccepts = false;
            validatorReason = 'Invalid block hash';
            showToastNotification(`❌ Validator rejected block hash!`, 'error');
          }
          // Validate difficulty
          else {
            const diffCheck = window.customValidator.validateDifficulty(block.hash, block.difficulty);
            if (diffCheck && diffCheck.valid === false) {
              validatorAccepts = false;
              validatorReason = diffCheck.reason || 'Difficulty validation failed';
              showToastNotification(`❌ Validator rejected block: ${validatorReason}`, 'error');
            }
          }
          // Validate all transactions inside the block
          if (validatorAccepts && block.transactions) {
            for (const tx of block.transactions) {
              const txCheck = window.customValidator.validateTransaction(tx, block.transactions);
              if (txCheck && txCheck.valid === false) {
                validatorAccepts = false;
                validatorReason = txCheck.reason || 'Transaction validation failed';
                showToastNotification(`❌ Validator rejected transaction: ${validatorReason}`, 'error');
                break;
              }
            }
          }
        } catch (e) {
          validatorAccepts = false;
          validatorReason = 'Validator crashed during validation';
          showToastNotification(`❌ ${validatorReason}!`, 'error');
        }
      }
    }

    // If we are on the collusion team and a fellow attacker found a block extending our secret chain
    // (Process this regardless of validator acceptance - collusion happens at network level)
    if (isColluding && block.previousHash === collusionTipHash) {
      collusionTipHash = block.hash;
      collusionHeight = block.index + 1;
      if (isMining) {
        stopMining();
        setTimeout(startMining, 100);
      }
    }

    // In client-relay mode, the admin hub has already accepted and is rebroadcasting.
    // We skip server-specific emits (add-to-personal-chain, process-peer-block, gossip-forward).
    // Local chain update happens below.
    // (Legacy real-p2p WebRTC path removed — mesh uses NetworkManager block-gossip.)
  }


// === NEW: Client-side (admin-relay) networking for participants/miners ===
function initClientSideNetworkingForParticipant(mode) {
  if (!window.NetworkManager) {
    console.error('[ParticipantNet] NetworkManager not loaded!');
    return;
  }

  net = new NetworkManager(mode);

  // Attach listeners BEFORE joinRoom so we catch the 'initial-state' response from admin
  // Wire the important events we used to get from socket
  net.on('admin-settings-updated', (msg) => {
    const settings = msg.payload || msg;
    debugLog('Settings updated via relay:', settings);
    lastKnownAdminSettings = normalizeAdminSettings(settings);

    if (settings.networkMode) {
      networkMode = settings.networkMode;
      localStorage.setItem('networkingMode_' + (net.roomCode || sessionId), networkMode);
      if (net && typeof net.setRoutingMode === 'function') {
        net.setRoutingMode(networkMode);
      }
      const note = networkMode === 'p2p'
        ? 'Full P2P mode — blocks gossip peer-to-peer; longest chain wins locally.'
        : 'Using Admin-hosted relay — keep the instructor tab open.';
      $('#networkModeNote').text(note);
      showToastNotification(networkMode === 'p2p' ? 'Switched to Full P2P mesh' : 'Switched to Admin-hosted hub', 'info');
    }

    // Update UI elements that the old 'settingsUpdated' handler touched
    if (settings.difficultyLeading !== undefined) {
      $('#difficultyLevel').text(settings.difficultyLeading + ' + 0x' + (settings.difficultySecondary != null ? settings.difficultySecondary : 8).toString(16));
    }

    if (settings.parametersLocked) {
      showToastNotification('Admin locked network parameters (difficulty/reward frozen)', 'info');
    }

    // Re-apply any mining parameter changes if mining
    if (isMining && !isColluding) {
      remineOnCanonicalTip();
    }
  });

  net.on('block-gossip', (msg) => {
    const block = (msg.payload && msg.payload.block) || msg.block;
    const minerId = (msg.payload && msg.payload.minerId) || msg.from;
    const chain = (msg.payload && msg.payload.chain) || msg.chain;
    if (chain && Array.isArray(chain) && chain.length > 0) {
      applyCanonicalChain(chain, {
        orphans: (msg.payload && msg.payload.orphans) || lastKnownOrphans,
        remine: true
      });
      return;
    }
    if (!block) return;
    if (block.hash) seenBlocks.add(block.hash);
    try { handleGossipBlock(block, minerId || 'peer'); } catch (e) {}
    if (!window.lastRelayedChain) window.lastRelayedChain = [];

    // NEW-side gossip: track as orphan tip, don't rewrite classic main mirror
    if (isNewForkId(block.forkId)) {
      noteNewForkBlock(block);
      if (isMining) remineOnCanonicalTip();
      return;
    }

    const tip = getClassicMiningTip(window.lastRelayedChain);
    if (!tip || block.previousHash === tip.hash) {
      // Only append classic extensions to local main mirror
      const last = window.lastRelayedChain[window.lastRelayedChain.length - 1];
      if (last && last.hash === tip.hash && block.previousHash === tip.hash) {
        window.lastRelayedChain.push(block);
      } else if (!last) {
        window.lastRelayedChain.push(block);
      }
      if (isMining) remineOnCanonicalTip();
    }
  });

  net.on('hard-fork-proposed', (msg) => {
    const data = msg.payload || msg;
    const height = data.height;
    const name = data.name || 'Hard Fork';
    pendingForkHeight = height != null ? Number(height) : null;
    pendingForkName = name;
    // Live admin proposal — show modal once (deduped inside)
    showForkProposalModal(name, height, { source: 'propose' });
    // Stay on classic until activation — remine so templates drop early 'new' forkIds
    if (isMining) remineOnCanonicalTip();
  });
  // Legacy alias (older admin builds) — same proposal, same dedupe key
  net.on('propose-hard-fork', (msg) => {
    const data = msg.payload || msg;
    pendingForkHeight = data.height != null ? Number(data.height) : null;
    pendingForkName = data.name || 'Hard Fork';
    showForkProposalModal(pendingForkName, pendingForkHeight, { source: 'propose' });
    if (isMining) remineOnCanonicalTip();
  });

  net.on('team-attack-started', (msg) => {
    const data = msg.payload || msg;
    debugLog('Team attack started via relay', data);
    handleTeamAttackStarted(data);
  });
  // Legacy alias
  net.on('start-team-attack', (msg) => {
    const data = msg.payload || msg;
    // Old payload may only have blocksBack — still show a notice
    if (data.colluders || data.forkBlock) handleTeamAttackStarted(data);
    else showToastNotification('Team attack signal received (incomplete payload)', 'warning');
  });

  net.on('network-toggled', handleNetworkToggled);
  // Legacy event name (admin used to send this; keep for any old tabs)
  net.on('toggle-network', handleNetworkToggled);

  net.on('block-accepted', (msg) => {
    const payload = msg.payload || msg;
    const block = payload.block;
    const minerId = payload.minerId;
    debugLog('Block accepted via relay from', minerId, {
      isFork: payload.isFork,
      reorg: payload.reorg,
      tipChanged: payload.tipChanged
    });
    $('#connectionStatusNote').hide();

    if (payload.pendingFork && payload.pendingFork.height != null) {
      pendingForkHeight = Number(payload.pendingFork.height);
      pendingForkName = payload.pendingFork.name || pendingForkName;
    }

    // Always absorb orphans / NEW blocks before any remine so we stick to our side
    if (Array.isArray(payload.orphans)) {
      mergeKnownOrphans(payload.orphans);
    }
    if (block && isNewForkId(block.forkId)) {
      noteNewForkBlock(block);
    }

    if (payload.chain && Array.isArray(payload.chain) && payload.chain.length > 0) {
      applyCanonicalChain(payload.chain, {
        participants: payload.participants || [],
        networkStats: payload.networkStats,
        orphans: payload.orphans || lastKnownOrphans,
        pendingTransactions: payload.pendingTransactions,
        remine: true
      });
      if (payload.reorg) {
        showToastNotification('Chain reorg — following longest chain', 'warning');
      } else if (payload.isFork && block && isNewForkId(block.forkId)) {
        // Hard-fork NEW side is intentional, not a lost race
        if (myForkChoice === 'new') {
          // keep mining the NEW tip
        }
      } else if (payload.isFork && myForkChoice !== 'new' && !(block && isNewForkId(block.forkId))) {
        showToastNotification('Your block lost a race (orphan) — mining on the winning tip', 'info');
      }
      return;
    }

    // Legacy / compact single-block payload (tip extension without full chain)
    if (block) {
      if (block.hash) seenBlocks.add(block.hash);
      try { handleGossipBlock(block, minerId || 'relay-admin'); } catch (e) {}
      if (!window.lastRelayedChain) window.lastRelayedChain = [];

      // Hub-confirmed height (compact path never called applyCanonicalChain before)
      if (payload.newHeight != null && !isNaN(Number(payload.newHeight))) {
        hubConfirmedHeight = Math.max(hubConfirmedHeight, Number(payload.newHeight));
      } else if (block.index != null && !isNewForkId(block.forkId) && !payload.isFork) {
        hubConfirmedHeight = Math.max(hubConfirmedHeight, Number(block.index));
      }

      // 1) Refresh mempool FIRST (before remine) so the next template is clean
      if (Array.isArray(payload.pendingTransactions)) {
        localPendingTxs = payload.pendingTransactions.slice();
      }
      // Always strip txs from this accepted block + local chain — hub pending can lag
      pruneLocalMempool(block);
      try {
        updatePendingTransactions({
          pendingTransactions: localPendingTxs,
          participants: payload.participants || []
        });
      } catch (e) {}

      // 2) Extend local main mirror only with classic-side tip extensions
      let shouldRemine = false;
      const tip = window.lastRelayedChain[window.lastRelayedChain.length - 1];
      if (isNewForkId(block.forkId)) {
        // Do not pollute lastRelayedChain with NEW blocks
        noteNewForkBlock(block);
        shouldRemine = isMining;
      } else if (!tip || tip.hash === block.hash) {
        shouldRemine = isMining;
      } else if (block.previousHash === tip.hash && isClassicForkId(block.forkId)) {
        window.lastRelayedChain.push(block);
        shouldRemine = isMining;
      } else if (block.previousHash === tip.hash && isNewForkId(block.forkId)) {
        noteNewForkBlock(block);
        shouldRemine = isMining;
      } else {
        // Stale/orphan without chain snapshot — ask hub for canonical state
        if (!payload.isFork) {
          net.send('request-state', { from: userId });
        } else {
          mergeKnownOrphans([block]);
          shouldRemine = isMining;
        }
      }
      if (shouldRemine) {
        remineOnCanonicalTip({ force: true });
      }

      if (payload.participants && payload.participants.length) {
        rememberParticipants(payload.participants);
        try { updateParticipantList({ participants: lastKnownParticipants }); } catch (e) {}
        try { applyMyBalanceFromParticipants(lastKnownParticipants); } catch (e) {}
      }
      if (payload.networkStats) {
        try {
          updateNetworkStats({
            networkStats: payload.networkStats,
            participants: lastKnownParticipants
          });
        } catch (e) {}
      }
      try {
        rememberParticipants(payload.participants || []);
        updateParticipantBlockchainView({ chain: getPersonalChainBlocks() }, lastKnownParticipants);
        refreshSharedNetworkView(lastKnownParticipants);
      } catch (e) {}
      if (payload.newHeight != null) {
        $('#blockHeight').text(payload.newHeight);
      } else if (block.index != null && !payload.isFork) {
        $('#blockHeight').text(block.index);
      }
    }
  });

  net.on('block-rejected', (msg) => {
    const payload = msg.payload || msg;
    const reason = (payload && payload.reason) || '';
    // Duplicates are benign (relay redelivery); never toast or thrash remine for them
    if (/duplicate/i.test(reason)) {
      debugWarn('Ignoring duplicate-block reject from hub', reason);
      return;
    }
    // Hub rejects while paused — treat as authoritative pause (missed toggle recovery)
    if (/network paused|paused by admin/i.test(reason)) {
      applyNetworkPaused(true, { silent: false });
      return;
    }
    debugWarn('Block rejected by hub', reason);
    if (payload && payload.chain && payload.chain.length) {
      applyCanonicalChain(payload.chain, { remine: true });
    } else {
      remineOnCanonicalTip();
      net.send('request-state', { from: userId });
    }
    showToastNotification(reason
      ? ('Block rejected: ' + reason)
      : 'Block rejected — remine on hub tip', 'warning');
  });

  net.on('transaction-accepted', (msg) => {
    const payload = msg.payload || msg;
    const list = payload.pendingTransactions;
    const tx = payload.transaction || payload;
    if (Array.isArray(list)) {
      localPendingTxs = list.slice();
    } else if (tx && tx.from && tx.to) {
      const id = tx.id || (tx.from + ':' + tx.to + ':' + tx.timestamp);
      if (!localPendingTxs.some((t) => (t.id || (t.from + ':' + t.to + ':' + t.timestamp)) === id)) {
        localPendingTxs.push(Object.assign({ id: id }, tx));
      }
    }
    updatePendingTransactions({
      pendingTransactions: localPendingTxs,
      participants: payload.participants || []
    });
    showToastNotification('Transaction added to mempool', 'success');
    // Fold new mempool txs into the next block — debounced to avoid mid-submit races
    scheduleRemineForMempool();
  });

  net.on('participants-roster', (msg) => {
    const payload = msg.payload || msg;
    const parts = payload.participants || [];
    if (!parts.length) return;
    rememberParticipants(parts);
    try { updateParticipantList({ participants: lastKnownParticipants }); } catch (e) {}
    try { applyMyBalanceFromParticipants(lastKnownParticipants); } catch (e) {}
    // Re-paint chains so miner names appear on blocks (mobile often only had addresses)
    try {
      updateParticipantBlockchainView(
        { chain: getPersonalChainBlocks() },
        lastKnownParticipants
      );
    } catch (e) {}
    try { refreshSharedNetworkView(lastKnownParticipants); } catch (e) {}
  });

  net.on('participant-updated', (msg) => {
    const payload = msg.payload || msg;
    const uid = payload.userId || payload.from || msg.from;
    const name = payload.name != null ? String(payload.name).trim() : '';
    if (uid && name) {
      rememberParticipants([{
        userId: uid,
        address: uid,
        name: name,
        displayName: name,
        role: payload.role || 'miner'
      }]);
      try { updateParticipantList({ participants: lastKnownParticipants }); } catch (e) {}
      try { refreshSharedNetworkView(lastKnownParticipants); } catch (e) {}
      try {
        updateParticipantBlockchainView(
          { chain: getPersonalChainBlocks() },
          lastKnownParticipants
        );
      } catch (e) {}
    }
    // Soft refresh — ask hub for full roster with balances
    if (net) net.send('request-state', { from: userId });
  });

  net.on('initial-state', (msg) => {
    const state = msg.payload || msg;
    if (window.LabSessionProbe) LabSessionProbe.notifyHubSeen();
    debugLog('Received initial state from admin relay', state);
    $('#connectionStatusNote').hide();
    $('#networkModeNote').text(
      networkMode === 'p2p'
        ? 'Full P2P mode — blocks gossip peer-to-peer.'
        : 'Connected to Admin-hosted relay — keep the instructor tab open.'
    );

    if (state.adminSettings) {
      lastKnownAdminSettings = normalizeAdminSettings(state.adminSettings);

      $('#difficultyLevel').text(
        (state.adminSettings.difficultyLeading || 4) + ' + 0x' +
        (state.adminSettings.difficultySecondary != null ? state.adminSettings.difficultySecondary : 8).toString(16)
      );

      // Push latest difficulty by restarting the mine loop on the hub tip
      if (isMining && lastKnownAdminSettings) {
        remineOnCanonicalTip();
      }
    }

    // If we received a real chain from the admin hub, feed it into local logic
    if (state.chain && Array.isArray(state.chain) && state.chain.length > 0) {
      applyCanonicalChain(state.chain, {
        participants: state.participants || [],
        networkStats: state.networkStats,
        orphans: state.orphans || [],
        pendingTransactions: state.pendingTransactions || [],
        remine: true
      });
      debugLog('Relayed chain length:', state.chain.length);

      try {
        const pend = state.pendingTransactions || [];
        const parts = state.participants || [];
        updatePendingTransactions({ pendingTransactions: pend, participants: parts });
        if (state.adminSettings) {
          updateDifficultyInfo(state.adminSettings);
        }
        const me = parts.find(p => p.address === userId || p.userId === userId);
        if (me && me.name) $('#nodeName').val(me.name);
      } catch (e) {
        console.error('Error updating participant UI from initial relayed state', e);
      }
    }

    if (typeof state.networkPaused === 'boolean') {
      applyNetworkPaused(state.networkPaused, { silent: !state.networkPaused });
    }
    if (state.pendingFork && state.pendingFork.height != null) {
      pendingForkHeight = Number(state.pendingFork.height);
      pendingForkName = state.pendingFork.name || 'Hard Fork';
      // Resync only — never re-popup if student already saw/chose this fork
      showForkProposalModal(pendingForkName, pendingForkHeight, { source: 'resync' });
    }
    if (Array.isArray(state.orphans)) {
      mergeKnownOrphans(state.orphans);
    }

    // loadBlockchainState(); // no-op in relay
  });

  net.on('admin-presence', (msg) => {
    if (window.LabSessionProbe) LabSessionProbe.notifyHubSeen();
    debugLog('Admin is present via relay:', msg.adminUserId || (msg.payload && msg.payload.adminUserId));
    // Resync pause from hub heartbeats (phones often miss one-shot toggles)
    const p = msg.payload || msg;
    if (typeof p.networkPaused === 'boolean' || typeof p.paused === 'boolean') {
      const want = typeof p.networkPaused === 'boolean' ? p.networkPaused : p.paused;
      if (want !== networkPaused) {
        applyNetworkPaused(want, { silent: false });
      } else if (want && isMining) {
        // Stuck mining while paused — force stop
        applyNetworkPaused(true, { silent: true });
      }
    }
  });

  net.on('peer-hello', (msg) => {
    if (msg && msg.isAdmin && window.LabSessionProbe) LabSessionProbe.notifyHubSeen();
  });

  // Now join (after listeners attached)
  const joinCode = localStorage.getItem('joinCode_' + sessionId) || sessionId;
  net.joinRoom(joinCode, userId, 'miner').then(() => {
    console.log('[ParticipantNet] Joined client-relay room:', joinCode, 'as', userId);
    showToastNotification('Connected via browser relay (no server)', 'success');
    $('#blockchainView').html('<p class="text-muted">Connected to relay hub. Waiting for initial chain state from admin...</p>');
    // Explicitly request the state in case the automatic peer-joined didn't trigger it
    net.send('request-state', { from: userId });
  });

  // Expose for debugging
  window.BlockchainLabNet = net;
}

// Parse unified diff format and display with colors
function parseDiffAndDisplay(diffText, oldCode, newCode) {
  if (!diffText) return;
  
  const lines = diffText.split('\n');
  let html = '<div style="border: 1px solid #dee2e6; border-radius: 4px; overflow: hidden;">';
  
  let contextLines = 0;
  
  for (let line of lines) {
    if (line.startsWith('---') || line.startsWith('+++')) {
      html += `<div class="diff-header">${escapeHtml(line)}</div>`;
    } else if (line.startsWith('@@')) {
      html += `<div class="diff-header">${escapeHtml(line)}</div>`;
      contextLines = 0;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      html += `<div class="diff-line removed">- ${escapeHtml(line.substring(1))}</div>`;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      html += `<div class="diff-line added">+ ${escapeHtml(line.substring(1))}</div>`;
    } else if (line.startsWith(' ')) {
      // Context lines - show first few to understand context
      if (contextLines < 2) {
        html += `<div class="diff-line context">  ${escapeHtml(line.substring(1))}</div>`;
        contextLines++;
      }
    } else if (line.trim() !== '') {
      // Other content - treat as context
      html += `<div class="diff-line context">  ${escapeHtml(line)}</div>`;
    }
  }
  
  html += '</div>';
  
  $('#diffContent').html(html);
  $('#codeDiffViewer').show();
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


// Switch to validator code tab
function switchToValidatorCodeTab() {
  $('a[href="#tabCode"]').tab('show');
  window.scrollTo(0, 0);
}

// ============ WEBRTC ENGINE ============
function setupWebRTC() {
  teardownWebRTC();
  if (socket) {
    socket.emit('request-webrtc-peers', { sessionId });
  }
  // In admin-relay, webrtc is not the primary; skip if no socket
}

function teardownWebRTC() {
  Object.values(rtcDataChannels).forEach(dc => dc.close());
  Object.values(rtcPeerConnections).forEach(pc => pc.close());
  rtcPeerConnections = {};
  rtcDataChannels = {};
}

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  rtcPeerConnections[peerId] = pc;
  pc.onicecandidate = e => {
    if (e.candidate && socket) socket.emit('webrtc-ice', { target: peerId, candidate: e.candidate });
  };
  pc.ondatachannel = e => setupDataChannel(peerId, e.channel);
  return pc;
}

function setupDataChannel(peerId, dc) {
  rtcDataChannels[peerId] = dc;
  dc.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'block') handleGossipBlock(data.block, data.minerId);
    } catch(err) { console.error('WebRTC parse error', err); }
  };
  dc.onopen = () => showToastNotification('WebRTC True P2P connected!', 'success');
}

async function createWebRTCOffer(peerId) {
  const pc = createPeerConnection(peerId);
  const dc = pc.createDataChannel('blockchain');
  setupDataChannel(peerId, dc);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  if (socket) socket.emit('webrtc-offer', { target: peerId, offer: offer });
}

function broadcastViaWebRTC(block, minerId) {
  const message = JSON.stringify({ type: 'block', block, minerId });
  Object.values(rtcDataChannels).forEach(dc => {
    if (dc.readyState === 'open') dc.send(message);
  });
}

function setupEventHandlers() {
  // CPU usage slider
  $('#cpuUsage').on('input', function() {
    cpuLimitPercent = parseInt($(this).val(), 10) || 20;
    $('#cpuUsageValue').text(cpuLimitPercent);
    // Live-adjust worker pace while hashing
    syncMiningWorkerPace();
  });
  
  // When opening Shared Network, repaint main + orphans (data may have arrived while on Personal tab)
  $('a[href="#tabNetwork"]').on('shown.bs.tab', function () {
    refreshSharedNetworkView();
  });

  // Mining buttons — when paused, these toggle "mining switch" intent only
  $('#mineBtn').click(function() {
    if (networkPaused) {
      // Arm mining so it auto-starts when the network resumes
      window.lastMiningIntent = true;
      updateMiningControlsUI();
      showToastNotification('Mining switch ON — will start when the network resumes', 'info');
      return;
    }
    startMining();
  });
  
  $('#stopMineBtn').click(function() {
    if (networkPaused) {
      // Disarm auto-resume
      window.lastMiningIntent = false;
      updateMiningControlsUI();
      showToastNotification('Mining switch OFF — will not auto-resume', 'info');
      return;
    }
    stopMining();
  });

  // Initial control labels
  if (typeof updateMiningControlsUI === 'function') updateMiningControlsUI();

  // Node name handler
  $('#setNodeNameBtn').click(function() {
    const nodeName = $('#nodeName').val().trim();
    if (!nodeName) {
      showToastNotification('Please enter a node name', 'error');
      return;
    }
    
    if (nodeName.length > 50) {
      showToastNotification('Node name must be 50 characters or less', 'error');
      return;
    }
    
    // Emit node name change via relay if possible
    if (net) {
      net.send('node-name-changed', { userId: userId, name: nodeName });
    } else if (socket) {
      socket.emit('node-name-changed', {
        sessionId: sessionId,
        userId: userId,
        name: nodeName
      });
    }

    // Optimistic local name so block miner rows update immediately (esp. mobile)
    if (userId) {
      rememberParticipants([{
        userId: userId,
        address: userId,
        name: nodeName,
        displayName: nodeName,
        role: 'miner'
      }]);
      try { updateParticipantList({ participants: lastKnownParticipants }); } catch (e) {}
      try {
        updateParticipantBlockchainView({ chain: getPersonalChainBlocks() }, lastKnownParticipants);
      } catch (e) {}
      try { refreshSharedNetworkView(lastKnownParticipants); } catch (e) {}
    }

    showToastNotification('Node name updated!', 'success');
  });
  
  // Allow Enter key to set node name
  $('#nodeName').keypress(function(e) {
    if (e.which === 13) {
      e.preventDefault();
      $('#setNodeNameBtn').click();
    }
  });
  $('#transactionForm').submit(function(e) {
    e.preventDefault();
    
    const recipientAddress = $('#recipientAddress').val().trim();
    const amount = parseFloat($('#transactionAmount').val());
    
    if (!recipientAddress || !amount || amount <= 0) {
      showToastNotification('Please enter a valid recipient address and amount', 'error');
      return;
    }
    
    sendTransaction(recipientAddress, amount);
  });

  // Validator Code Editor Handlers
  $('#submitValidatorCodeBtn').click(function() {
    const modifiedCode = $('#validatorCodeEditor').val();
    if (typeof modifiedCode === 'string' && modifiedCode.includes('WALLET DOUBLE SPEND SCRIPT')) {
      showToastNotification('This is a wallet attack script — use Execute Double Spend, not Submit.', 'warning');
      return;
    }

    // Apply to local node immediately (and any other tabs via ValidatorBridge)
    const compileResult = applyCustomValidator(modifiedCode);
    if (compileResult !== true) {
      showToastNotification('Validator Compile Error: ' + compileResult, 'error');
      window.customValidator = { _broken: true }; // Intentionally break their miner
    } else {
      if (window.ValidatorBridge) ValidatorBridge.save(sessionId, modifiedCode);
      showToastNotification('Custom validator rules applied to your node!', 'success');
    }
  });
  
  $('#resetValidatorCodeBtn').click(function() {
    if (confirm('Are you sure you want to reset to the original validation code?')) {
      try { delete window.customValidator; } catch (e) { window.customValidator = null; }
      const src = (typeof originalValidatorCode === 'string') ? originalValidatorCode : '';
      $('#validatorCodeEditor').val(src);
      if (window.ValidatorBridge) ValidatorBridge.clear(sessionId);
      const resetResult = applyCustomValidator(src);
      $('#executeDoubleSpendBtn').hide();
      $('#submitValidatorCodeBtn').show();
      if (resetResult === true) {
        showToastNotification('Validator reset to original code!', 'success');
      } else {
        showToastNotification('Validator reset (built-in rules). Reload note: ' + resetResult, 'warning');
      }
    }
  });
  
  $('#btnSetupDoubleSpend').click(function() {
    const walletCode = `// --- WALLET DOUBLE SPEND SCRIPT ---
// The blockchain strictly prevents double spending in the mempool.
// To bypass this, we must send Transaction 1 to the network normally,
// and secretly mine Transaction 2 into a private fork!

// 1. Put the first address here (Main Chain Target)
const target1 = "REPLACE_WITH_ADDRESS_1";

// 2. Put the second address here (Secret Fork Target)
const target2 = "REPLACE_WITH_ADDRESS_2";

// 3. Enter the amount to double spend
const amount = 50;

// When you click Execute, your wallet will:
// A) Broadcast Target 1 to the honest network
// B) Start secretly mining Target 2
executeDoubleSpendAttack(target1, target2, amount);
`;
    $('#validatorCodeEditor').val(walletCode);
    $('#submitValidatorCodeBtn').hide();
    
    if ($('#executeDoubleSpendBtn').length === 0) {
      $('<button class="btn btn-danger" id="executeDoubleSpendBtn">Execute Double Spend Attack</button>')
        .insertAfter('#validatorCodeEditor');
        
      $('#executeDoubleSpendBtn').click(function() {
        try {
          window.executeDoubleSpendAttack = function(t1, t2, amt) {
            sendTransaction(t1, amt);
            // In client-relay mode, simulate the chain tip from relayed state or just set
            collusionTipHash = window.lastRelayedChain && window.lastRelayedChain.length ? window.lastRelayedChain[window.lastRelayedChain.length-1].hash : null;
            collusionHeight = window.lastRelayedChain ? window.lastRelayedChain.length : 0;
            collusionTransactions = [{ id: 'ds-' + Date.now(), from: userId, to: t2, amount: amt, timestamp: Date.now() }];
            isColluding = true;
            $('#collusionBanner').remove();
            $('#miningActivity').prepend('<div class="alert alert-danger" id="collusionBanner"><strong>🚨 DOUBLE SPEND FORK ACTIVE</strong><br>Mining secret chain to rewrite history!</div>');
            if (isMining) stopMining();
            setTimeout(startMining, 500);
          };
          eval($('#validatorCodeEditor').val());
          showToastNotification('Double spend attack initiated!', 'warning');
        } catch(e) {
          showToastNotification('Script error: ' + e.message, 'error');
        }
      });
    }
    $('#executeDoubleSpendBtn').show();
  });

  // Copy address button
  $(document).on('click', '.copy-btn', function() {
    const text = $(this).data('clipboard-text');
    navigator.clipboard.writeText(text).then(() => {
      showToastNotification('Address copied to clipboard!', 'success');
    }).catch(err => {
      console.error('Could not copy text: ', err);
    });
  });

  // Fill recipient from participant directory
  $(document).on('click', '.use-recipient-btn', function () {
    const addr = $(this).data('address') || $(this).attr('data-address');
    if (!addr) return;
    $('#recipientAddress').val(addr);
    $('#transactionAmount').focus();
    showToastNotification('Recipient set — enter an amount and send', 'info');
  });
  
  // Hard fork voting handlers
  $('#btnRejectFork').click(function() {
    myForkChoice = 'classic';
    localNewForkTip = null;
    lockForkChoice('classic');
    if (net) net.send('hard-fork-vote', { choice: 'classic' });
    try { $('#forkChoiceModal').modal('hide'); } catch (e) {}
    showToastNotification(
      'You chose Classic. Blocks stay classic until activation' +
      (pendingForkHeight != null ? ' at #' + pendingForkHeight : '') + '.',
      'info'
    );
    if (isMining) remineOnCanonicalTip();
  });

  $('#btnAcceptFork').click(function() {
    myForkChoice = 'new';
    localClassicForkTip = null;
    lockForkChoice('new');
    if (net) net.send('hard-fork-vote', { choice: 'new' });
    try { $('#forkChoiceModal').modal('hide'); } catch (e) {}
    showToastNotification(
      'You chose New Chain. You still mine classic until block ' +
      (pendingForkHeight != null ? pendingForkHeight : '?') +
      ', then split off and stay on the NEW tip.',
      'warning'
    );
    if (isMining) remineOnCanonicalTip();
  });

  // Fork toggling handlers
  $('#forkControlPanel').on('click', '#btnFollowClassic', function() {
    myForkChoice = 'classic';
    localNewForkTip = null;
    lockForkChoice('classic');
    if (net) net.send('hard-fork-vote', { choice: 'classic' });
    showToastNotification('Switched to Classic Chain.', 'info');
    if (isMining) remineOnCanonicalTip();
  });
  $('#forkControlPanel').on('click', '#btnFollowNew', function() {
    myForkChoice = 'new';
    localClassicForkTip = null;
    lockForkChoice('new');
    if (net) net.send('hard-fork-vote', { choice: 'new' });
    showToastNotification(
      'Switched to New Chain (active at block ' +
      (pendingForkHeight != null ? pendingForkHeight : '?') +
      '). You will stick to the NEW tip after activation.',
      'warning'
    );
    if (isMining) remineOnCanonicalTip();
  });
}

/**
 * Apply admin pause/resume. Defensive payload parsing for MQTT/presence shapes.
 * @param {object|boolean} msgOrPaused - event msg or boolean
 * @param {{silent?: boolean}} [opts]
 */
function applyNetworkPaused(msgOrPaused, opts) {
  opts = opts || {};
  let willPause;
  if (typeof msgOrPaused === 'boolean') {
    willPause = msgOrPaused;
  } else {
    const p = (msgOrPaused && (msgOrPaused.payload || msgOrPaused)) || {};
    if (typeof p.paused === 'boolean') willPause = p.paused;
    else if (typeof p.networkPaused === 'boolean') willPause = p.networkPaused;
    else if (typeof msgOrPaused.paused === 'boolean') willPause = msgOrPaused.paused;
    else if (typeof msgOrPaused.networkPaused === 'boolean') willPause = msgOrPaused.networkPaused;
    else return; // no usable flag
  }

  const prev = networkPaused;
  networkPaused = !!willPause;

  if (networkPaused) {
    if (isMining) {
      stopMining({ preserveIntent: true });
    }
    // Kill any in-flight worker even if isMining was already false
    if (miningWorker) {
      try {
        miningWorker.postMessage({ command: 'stop' });
        miningWorker.terminate();
      } catch (e) {}
      miningWorker = null;
    }
    if (!opts.silent || !prev) {
      showToastNotification('Network paused by admin — mining halted', 'warning');
    }
  } else {
    if (!opts.silent || prev) {
      showToastNotification('Network resumed by admin', 'success');
    }
    if (window.lastMiningIntent && !isMining && !isColluding) {
      setTimeout(startMining, 100);
    }
  }
  updateMiningControlsUI();
}

function handleNetworkToggled(msg) {
  applyNetworkPaused(msg, { silent: false });
}

/**
 * Keep Start/Stop labels + status badges in sync with:
 * - mining switch intent (lastMiningIntent)
 * - network pause
 * - whether we are actually hashing
 */
function updateMiningControlsUI() {
  const intent = !!window.lastMiningIntent;
  const paused = !!networkPaused;
  const hashing = !!isMining;

  const $mine = $('#mineBtn');
  const $stop = $('#stopMineBtn');
  const $hint = $('#miningControlHint');
  const $intent = $('#miningIntentBadge');
  const $net = $('#networkLiveBadge');
  const $hash = $('#hashingBadge');

  // Status badges
  if ($intent.length) {
    $intent
      .text(intent ? 'Mining switch: ON' : 'Mining switch: OFF')
      .removeClass('label-default label-success label-warning')
      .addClass(intent ? 'label-success' : 'label-default');
  }
  if ($net.length) {
    $net
      .text(paused ? 'Network: Paused' : 'Network: Live')
      .removeClass('label-default label-success label-warning label-danger')
      .addClass(paused ? 'label-warning' : 'label-success');
  }
  if ($hash.length) {
    $hash
      .text(hashing ? 'Hashing: Yes' : 'Hashing: No')
      .removeClass('label-default label-info label-success')
      .addClass(hashing ? 'label-info' : 'label-default');
  }

  if (paused) {
    // Not hashing while paused — buttons toggle intent (arm / disarm resume)
    $mine.prop('disabled', false).show();
    $stop.prop('disabled', false);
    if (intent) {
      $mine.hide();
      $stop
        .show()
        .removeClass('btn-success')
        .addClass('btn-warning')
        .text('Turn Mining Off (network paused)');
      if ($hint.length) {
        $hint.text('Mining switch is ON. Hashing is stopped until the admin resumes the network.');
      }
    } else {
      $stop.hide();
      $mine
        .show()
        .removeClass('btn-warning')
        .addClass('btn-success')
        .text('Turn Mining On (network paused)');
      if ($hint.length) {
        $hint.text('Mining switch is OFF. You can arm it now; hashing starts only when the network is live.');
      }
    }
    return;
  }

  // Network live
  if (hashing) {
    $mine.hide();
    $stop
      .show()
      .removeClass('btn-success')
      .addClass('btn-warning')
      .text('Stop Mining')
      .prop('disabled', false);
    if ($hint.length) {
      $hint.text('Mining switch ON — this node is actively hashing.');
    }
  } else {
    $stop.hide();
    $mine
      .show()
      .removeClass('btn-warning')
      .addClass('btn-success')
      .text(intent ? 'Start Mining (armed)' : 'Start Mining')
      .prop('disabled', false);
    if ($hint.length) {
      $hint.text(
        intent
          ? 'Mining switch ON but not hashing yet — click Start if needed, or wait for auto-resume.'
          : 'Mining switch OFF — click Start Mining to begin.'
      );
    }
  }
}

function forkProposalKey(name, height) {
  const h = height != null ? Number(height) : '';
  const n = (name != null ? String(name) : '').trim() || 'Hard Fork';
  return h + '::' + n;
}

function lockForkChoice(choice) {
  myForkChoice = choice === 'new' ? 'new' : 'classic';
  const key = forkProposalKey(pendingForkName, pendingForkHeight);
  if (pendingForkHeight != null) {
    forkChoiceLockedKey = key;
    shownForkProposalKey = key;
  }
  try {
    if (sessionId && pendingForkHeight != null) {
      sessionStorage.setItem(
        'forkChoice_' + sessionId,
        JSON.stringify({
          key: key,
          choice: myForkChoice,
          height: pendingForkHeight,
          name: pendingForkName
        })
      );
    }
  } catch (e) {}
}

function restoreForkChoiceFromSession() {
  if (!sessionId) return;
  try {
    const raw = sessionStorage.getItem('forkChoice_' + sessionId);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || saved.height == null) return;
    pendingForkHeight = Number(saved.height);
    pendingForkName = saved.name || 'Hard Fork';
    const key = saved.key || forkProposalKey(pendingForkName, pendingForkHeight);
    shownForkProposalKey = key;
    forkChoiceLockedKey = key;
    myForkChoice = saved.choice === 'new' ? 'new' : 'classic';
  } catch (e) {}
}

/**
 * Show hard-fork modal + persistent fork control panel.
 * @param {string} name
 * @param {number|string} height
 * @param {{ source?: 'propose'|'resync', force?: boolean }} [opts]
 *   - propose: admin just proposed (show modal once)
 *   - resync: initial-state / MQTT catch-up (never re-popup if already shown/chosen)
 */
function showForkProposalModal(name, height, opts) {
  opts = opts || {};
  const source = opts.source || 'propose';
  const force = !!opts.force;

  pendingForkHeight = height != null ? Number(height) : pendingForkHeight;
  pendingForkName = name || pendingForkName || 'Hard Fork';
  const n = pendingForkName;
  const h = pendingForkHeight != null ? pendingForkHeight : '?';
  const key = forkProposalKey(n, pendingForkHeight);

  // Always keep panel + labels in sync
  $('#forkProposalName').text(n);
  $('#forkProposalHeight').text(h);
  $('#forkControlPanel').show();
  // Clarify: choice only affects blocks at/after activation
  if (!$('#forkActivationNote').length) {
    $('#forkControlPanel').append(
      '<p id="forkActivationNote" class="small text-muted" style="margin-top:10px;margin-bottom:0;">' +
      'Until block <strong>' + h + '</strong>, everyone still mines the classic chain. ' +
      'After activation, “New Chain” miners build a separate fork from block ' +
      (h !== '?' ? (Number(h) - 1) : 'N-1') + '.</p>'
    );
  } else {
    $('#forkActivationNote').html(
      'Until block <strong>' + h + '</strong>, everyone still mines the classic chain. ' +
      'After activation, “New Chain” miners build a separate fork from block ' +
      (h !== '?' ? (Number(h) - 1) : 'N-1') + '.'
    );
  }

  // Already chose this proposal — keep panel, never re-open modal/toast
  if (!force && forkChoiceLockedKey === key) {
    try { $('#forkChoiceModal').modal('hide'); } catch (e) {}
    return;
  }

  // Already shown this proposal (MQTT redelivery, dual event names, or resync)
  if (!force && shownForkProposalKey === key) {
    // Resync after dismiss without choosing: leave panel up, no modal spam
    if (source === 'resync') {
      try { $('#forkChoiceModal').modal('hide'); } catch (e) {}
    }
    return;
  }

  // First time we learn about this proposal on a pure resync (tab refreshed mid-fork):
  // show modal once so they can still pick a side.
  shownForkProposalKey = key;

  try {
    if (typeof $('#forkChoiceModal').modal === 'function') {
      $('#forkChoiceModal').modal('show');
    }
  } catch (e) {
    console.warn('Could not open fork modal', e);
  }

  showToastNotification(
    'Hard fork proposed: ' + n + ' activates at block ' + h +
    ' — choose a side (mining stays classic until then)',
    'warning'
  );
}

/** Sticky collusion banner (outside #miningActivity so mine loop HTML won't wipe it). */
function showCollusionBanner(htmlInner) {
  $('#collusionBanner').remove();
  const banner = $('<div class="alert alert-danger" id="collusionBanner" style="margin:10px 0;"></div>')
    .html(htmlInner);
  if ($('#forkControlPanel').length) {
    $('#forkControlPanel').after(banner);
  } else if ($('#blockchainView').length) {
    $('#blockchainView').before(banner);
  } else {
    $('.container-fluid, .container').first().prepend(banner);
  }
}

/**
 * Apply team collusion assignment from admin.
 * Colluders mine a private fork from forkBlock; honest stay on the tip.
 */
function handleTeamAttackStarted(data) {
  data = data || {};
  const colluders = data.colluders || [];
  const honest = data.honest || [];
  const forkBlock = data.forkBlock || {};
  const onTeam = colluders.indexOf(userId) >= 0;
  const onHonest = honest.indexOf(userId) >= 0;

  // Expose for audits / debugging
  window.__labCollusion = {
    onTeam: onTeam,
    onHonest: onHonest,
    colluders: colluders.slice(),
    honest: honest.slice(),
    forkBlock: forkBlock,
    userId: userId
  };

  if (onTeam) {
    isColluding = true;
    collusionTipHash = forkBlock.hash || null;
    if (!collusionTipHash && window.lastRelayedChain && window.lastRelayedChain.length) {
      const back = Math.max(1, data.blocksBack || 2);
      const idx = Math.max(0, window.lastRelayedChain.length - 1 - back);
      collusionTipHash = window.lastRelayedChain[idx].hash;
    }
    collusionHeight = (forkBlock.index != null ? forkBlock.index : 0) + 1;
    collusionTransactions = localPendingTxs.slice(0, 5);

    showCollusionBanner(
      '<strong>Team collusion active</strong> — you are on the attack team.<br>' +
      'Mining a private fork from block #' + (forkBlock.index != null ? forkBlock.index : '?') +
      (collusionTipHash ? ' (' + String(collusionTipHash).substring(0, 12) + '…)' : '')
    );

    showToastNotification('You are a COLLUDER — mining a secret fork off block #' +
      (forkBlock.index != null ? forkBlock.index : '?'), 'warning');

    // Restart miner on the secret tip
    if (isMining) {
      try { if (miningWorker) { miningWorker.postMessage({ command: 'stop' }); miningWorker.terminate(); } } catch (e) {}
      miningWorker = null;
      fetchDataAndMine();
    } else if (window.lastMiningIntent) {
      setTimeout(startMining, 200);
    }
  } else {
    // Honest (or unlisted) miner — stay on main chain
    isColluding = false;
    collusionTipHash = null;
    $('#collusionBanner').remove();
    if (onHonest || colluders.length) {
      showCollusionBanner(
        '<strong>Team 51% attack started</strong> — you are on the <em>honest</em> chain. Watch for a competing fork from colluders.'
      );
      $('#collusionBanner').removeClass('alert-danger').addClass('alert-info');
      showToastNotification(
        'Team 51% attack started — you are on the HONEST chain. Watch for a competing fork.',
        'info'
      );
    } else {
      showToastNotification('Team 51% attack simulation active on the network', 'warning');
    }
  }
}

function startMining() {
  if (isMining) return;
  window.lastMiningIntent = true;
  setupBackgroundMiningGuards();
  startMiningKeepalive();
  if (networkPaused) {
    updateMiningControlsUI();
    showToastNotification('Mining switch ON — network is paused; hashing starts on resume', 'warning');
    return;
  }

  isMining = true;
  updateMiningControlsUI();
  requestMiningWakeLock();
  fetchDataAndMine();
}

function seedLocalGenesisChain() {
  if (window.lastRelayedChain && window.lastRelayedChain.length > 0) return;
  const genesis = {
    index: 0,
    hash: '0000000000000000000000000000000000000000000000000000000000000000',
    previousHash: '0',
    timestamp: Date.now() - 10000,
    nonce: 0,
    transactions: [],
    miner: 'genesis',
    data: 'Genesis Block - Blockchain Lab (Client Relay)'
  };
  window.lastRelayedChain = [genesis];
  seenBlocks.add(genesis.hash);
  lastKnownAdminSettings = normalizeAdminSettings({
    difficultyLeading: 4,
    difficultySecondary: 8,
    miningRewardCoins: 10
  });
  $('#difficultyLevel').text('3 + 0xF');
  $('#blockchainView').append(
    '<div class="alert alert-warning">Local genesis ready. Start mining — blocks will sync when the instructor hub connects.</div>'
  );
}

function normalizeAdminSettings(settings) {
  const s = Object.assign({}, settings || {});
  const leading = parseInt(s.difficultyLeading, 10);
  const secondary = s.difficultySecondary !== undefined ? parseInt(s.difficultySecondary, 10) : 8;
  s.difficultyLeading = isNaN(leading) ? 4 : leading;
  s.difficultySecondary = isNaN(secondary) ? 8 : secondary;
  if (!s.currentDifficulty || typeof s.currentDifficulty !== 'object') {
    s.currentDifficulty = {
      leadingZeros: s.difficultyLeading,
      secondaryHex: Number(s.difficultySecondary).toString(16).toUpperCase()
    };
  } else {
    s.currentDifficulty.leadingZeros = s.currentDifficulty.leadingZeros || s.difficultyLeading;
    if (s.currentDifficulty.secondaryHex === undefined) {
      s.currentDifficulty.secondaryHex = Number(s.difficultySecondary).toString(16).toUpperCase();
    }
  }
  return s;
}

function getMiningDifficulty() {
  if (lastKnownAdminSettings && lastKnownAdminSettings.currentDifficulty &&
      typeof lastKnownAdminSettings.currentDifficulty === 'object') {
    return lastKnownAdminSettings.currentDifficulty;
  }
  return normalizeAdminSettings(lastKnownAdminSettings || {}).currentDifficulty;
}

function fetchDataAndMine() {
  if (!isMining) return;
  if (networkPaused) {
    stopMining({ preserveIntent: true });
    return;
  }

  // If we are colluding, we mine on our secret fork instead of the main tip
  if (isColluding && collusionTipHash) {
    const newBlock = {
      index: collusionHeight,
      timestamp: Date.now(),
      nonce: 0,
      previousHash: collusionTipHash,
      transactions: collusionTransactions,
      miner: userId,
      difficulty: getMiningDifficulty(),
      hash: '',
      forkId: myForkChoice
    };
    mineBlock(newBlock, lastKnownAdminSettings);
    return;
  }

  // In client-relay, use the chain relayed from the admin hub (+ orphan tips for hard fork)
  if (window.lastRelayedChain && window.lastRelayedChain.length > 0) {
    const tmpl = getMiningTemplate();
    if (!tmpl) {
      setTimeout(fetchDataAndMine, 300);
      return;
    }
    if (tmpl.waitForHub) {
      showWaitingForHub(tmpl.waitingOn);
      return;
    }
    if (submittedSlots.has(blockSlotKey(tmpl))) {
      showWaitingForHub(tmpl.index);
      return;
    }
    clearWaitingForHub();
    const newBlock = {
      index: tmpl.index,
      timestamp: Date.now(),
      nonce: 0,
      previousHash: tmpl.previousHash,
      transactions: mempoolForNextBlock(),
      miner: userId,
      difficulty: getMiningDifficulty(),
      hash: '',
      forkId: tmpl.forkId
    };
    mineBlock(newBlock, lastKnownAdminSettings);
  } else {
    // No state yet — seed genesis once, then mine
    seedLocalGenesisChain();
    setTimeout(fetchDataAndMine, 200);
  }
}

function mineBlock(block, adminSettings) {
  // Report to network which block we're mining on (via relay if possible)
  if (net) {
    net.send('mining-on-block', {
      blockHash: block.previousHash,
      minerAddress: userId
    });
  } else if (typeof socket !== 'undefined' && socket) {
    socket.emit('mining-on-block', {
      sessionId: sessionId,
      blockHash: block.previousHash,
      minerAddress: userId
    });
  }

  updateMiningActivityUi(block.index);
  currentMiningBlock = block;
  setupBackgroundMiningGuards();
  startMiningKeepalive();
  requestMiningWakeLock();

  // Prefer full PoW inside a Web Worker so background tabs keep hashing.
  // Fall back to main-thread mining when a custom student validator is active.
  if (canUseWorkerMining()) {
    startWorkerMiningJob(block);
  } else {
    mineBlockOnMainThread(block, adminSettings);
  }
}

/**
 * Legacy/fallback: hash on the main thread, paced by a tiny worker timer.
 * Used only when a custom validator is installed (cannot be serialized into the worker).
 */
function mineBlockOnMainThread(block, adminSettings) {
  const startTime = Date.now();
  let nonce = 0;
  let totalIterations = 0;
  currentMiningBlock = block;

  // Stop any prior main-thread loop
  if (mainThreadMineTimer) {
    clearTimeout(mainThreadMineTimer);
    mainThreadMineTimer = null;
  }
  // Soft-stop worker so we don't double-mine
  if (miningWorker) {
    try { miningWorker.postMessage({ command: 'stop' }); } catch (e) {}
  }

  const gen = ++miningJobGen;

  function tick() {
    if (!isMining || networkPaused || gen !== miningJobGen) {
      if (networkPaused && isMining) stopMining({ preserveIntent: true });
      return;
    }

    const batchSize = document.hidden ? 500 : 1000;
    for (let i = 0; i < batchSize; i++) {
      const blockObj = {
        index: block.index,
        timestamp: block.timestamp,
        nonce: nonce,
        previousHash: block.previousHash,
        transactions: block.transactions,
        miner: block.miner,
        difficulty: block.difficulty,
        forkId: block.forkId
      };
      const hash = sha256(JSON.stringify(canonicalizeObject(blockObj)));
      if (isValidHash(hash, block.difficulty)) {
        block.hash = hash;
        block.nonce = nonce;
        if (isColluding) {
          collusionTipHash = hash;
          collusionHeight++;
          collusionTransactions = [];
        }
        const minedBlock = JSON.parse(JSON.stringify(block));
        seenBlocks.add(hash);
        pruneLocalMempool(minedBlock);
        if (isNewForkId(minedBlock.forkId)) {
          noteNewForkBlock(minedBlock);
        } else if (
          pendingForkHeight != null &&
          minedBlock.index != null &&
          Number(minedBlock.index) >= Number(pendingForkHeight)
        ) {
          noteClassicForkBlock(minedBlock);
        }
        submitMinedBlock(minedBlock, startTime, totalIterations);

        const nextTmpl = getMiningTemplate();
        const capClassic = myForkChoice !== 'new';
        if (
          !nextTmpl ||
          nextTmpl.waitForHub ||
          (capClassic &&
            nextTmpl.index != null &&
            Number(nextTmpl.index) > hubConfirmedHeight + 1)
        ) {
          showWaitingForHub((nextTmpl && nextTmpl.waitingOn) || minedBlock.index);
          return;
        }
        block.index = nextTmpl.index;
        block.previousHash = nextTmpl.previousHash;
        block.forkId = nextTmpl.forkId;
        block.nonce = 0;
        block.hash = '';
        block.transactions = mempoolForNextBlock();
        block.timestamp = Date.now();
        nonce = 0;
        updateMiningActivityUi(block.index);
        if (net) {
          net.send('mining-on-block', {
            blockHash: block.previousHash,
            minerAddress: userId
          });
        }
        break;
      }
      nonce++;
      totalIterations++;
    }

    lastWorkerProgressAt = Date.now();
    const elapsed = Math.max(0.1, (Date.now() - startTime) / 1000);
    const hashrate = Math.max(1, Math.floor(totalIterations / elapsed));
    try {
      const nc = document.getElementById('nonceCount');
      if (nc) nc.textContent = nonce.toLocaleString();
      const ch = document.getElementById('currentHashrate');
      if (ch) ch.textContent = hashrate.toLocaleString();
      const yh = document.getElementById('yourHashrate');
      if (yh) yh.textContent = hashrate.toLocaleString() + ' H/s';
    } catch (e) {}

    const now = Date.now();
    if (now - lastHashrateEmitAt > 2000) {
      lastHashrateEmitAt = now;
      emitHashrate(hashrate);
    }

    // When hidden, browsers throttle setTimeout heavily — use shortest delay
    const delay = document.hidden ? 0 : getMineCpuDelay();
    mainThreadMineTimer = setTimeout(tick, delay);
  }

  tick();
}

function getMineCpuDelay() {
  // Map CPU percentage to delay
  // 100% = 0ms (max speed), 50% = 25ms delay, 10% = 225ms delay
  const delayMs = Math.max(0, (100 - cpuLimitPercent) * 2.5);
  return delayMs;
}

function submitMinedBlock(block, startTime, totalIterations) {
  const totalTime = Date.now() - startTime;
  const hashrate = Math.floor(totalIterations / (totalTime / 1000));

  if (!block || !block.hash) return;
  if (submittedBlockHashes.has(block.hash)) {
    debugLog('Skip re-submit of already submitted block', block.hash.substring(0, 16));
    return;
  }
  submittedBlockHashes.add(block.hash);
  if (submittedBlockHashes.size > 500) {
    submittedBlockHashes = new Set(Array.from(submittedBlockHashes).slice(-200));
  }
  const slot = blockSlotKey(block);
  if (slot) submittedSlots.add(slot);
  lastSubmittedBlock = block;
  
  // In pure client-relay mode, we bypass the old /lab/mine server POST
  // and directly submit to the admin hub via the relay.
  showToastNotification(`⏳ Block found! Broadcasting to peers via relay...`, 'info');

  // Optimistic tip so mempool remines don't restart on a stale parent and re-race submits
  pushOptimisticTip(block);
  
  if (net) {
    debugLog('Broadcasting mined block via client relay');
    // In Full P2P mode, gossip the block to peers; otherwise submit to admin hub
    if (networkMode === 'p2p' || lastKnownAdminSettings?.networkMode === 'p2p' || lastKnownAdminSettings?.networkMode === 'real-p2p') {
      net.send('block-gossip', { block, minerId: userId });
      // Also emit locally as accepted for immediate UI feedback
      try { handleGossipBlock(block, userId); } catch (e) {}
    } else {
      net.send('block-submitted', { block, minerId: userId });
    }
  } else {
    console.warn('No net available for block submit');
  }
  
  // Optimistically continue mining on the new tip we just found
  // (the admin will confirm via block-accepted and we may reorg if needed)
}

function stopMining(opts) {
  const preserveIntent = !!(opts && opts.preserveIntent);
  isMining = false;
  if (!preserveIntent) {
    window.lastMiningIntent = false;
    stopMiningKeepalive();
    releaseMiningWakeLock();
  }
  miningJobGen++;
  currentMiningBlock = null;
  $('#miningActivity').html(
    preserveIntent
      ? '<p class="text-warning">Mining paused by admin (will resume automatically if switch stays ON)</p>'
      : '<p class="text-muted">Mining stopped</p>'
  );
  $('#yourHashrate').text('0 H/s');

  if (mainThreadMineTimer) {
    clearTimeout(mainThreadMineTimer);
    mainThreadMineTimer = null;
  }

  if (miningWorker) {
    try { miningWorker.postMessage({ command: 'stop' }); } catch (e) {}
    // Keep the worker process around while intent remains so resume is faster
    if (!preserveIntent) {
      try { miningWorker.terminate(); } catch (e) {}
      miningWorker = null;
      miningWorkerReady = false;
    }
  }

  // Notify the network that we have stopped mining
  emitHashrate(0);

  updateMiningControlsUI();
}

function sendTransaction(recipientAddress, amount) {
  if (networkPaused) {
    showToastNotification('Network is paused by admin — transactions blocked', 'warning');
    return;
  }
  if (net) {
    const tx = {
      from: userId,
      to: recipientAddress,
      amount: amount,
      timestamp: Date.now()
    };
    net.send('transaction-submitted', { transaction: tx });
    $('#transactionForm')[0].reset();
    showToastNotification(`✅ Transaction submitted via relay to ${recipientAddress.substring(0, 8)}... for ${amount} coins`, 'success');
  } else {
    showToastNotification('No relay connection for transaction', 'error');
  }
}

function normalizeValidatorSource(code) {
  if (typeof code === 'string') return code;
  if (code && typeof code === 'object' && typeof code.value === 'string') return code.value;
  return '';
}

function loadValidatorCode() {
  var url = (window.LabPaths && LabPaths.assetUrl)
    ? LabPaths.assetUrl('/data/validator-code.json')
    : '/data/validator-code.json';
  // Prefer static asset; fall back to Express route for local npm start
  $.getJSON(url).done(function(data) {
    const src = normalizeValidatorSource(data && data.code);
    if (src) {
      originalValidatorCode = src;
      var saved = (window.ValidatorBridge && ValidatorBridge.load(sessionId)) || '';
      var use = (saved && saved.trim() && saved.trim() !== src.trim()) ? saved : src;
      $('#validatorCodeEditor').val(use);
      applyCustomValidator(use);
    }
  }).fail(function() {
    $.get('/lab/validator-code', function(data) {
      const src = normalizeValidatorSource(data && data.code);
      if (data && data.success && src) {
        originalValidatorCode = src;
        var savedFb = (window.ValidatorBridge && ValidatorBridge.load(sessionId)) || '';
        var useFb = (savedFb && savedFb.trim() && savedFb.trim() !== src.trim()) ? savedFb : src;
        $('#validatorCodeEditor').val(useFb);
        applyCustomValidator(useFb);
      } else {
        $('#validatorCodeEditor').val('// Error loading code: ' + ((data && data.error) || 'unknown'));
      }
    }).fail(function() {
      $('#validatorCodeEditor').val('// Failed to load validator code.');
    });
  });
}

function loadBlockchainState() {
  // Legacy server-based load removed for client-relay only mode.
  // Updates come via net messages and handleGossipBlock / populate calls.
  if (typeof debugLog === 'function') debugLog('loadBlockchainState no-op in client-relay');
}

/**
 * Blocks for the Personal tab: follow the miner's chosen hard-fork side so
 * NEW-side miners don't only see classic main with their blocks "orphaned".
 */
function getPersonalChainBlocks() {
  const main = window.lastRelayedChain || [];
  if (myForkChoice !== 'new' || pendingForkHeight == null) {
    // Classic (or no fork): hub main is our chain; prefer sticky classic tip path if longer
    if (localClassicForkTip && localClassicForkTip.hash) {
      const path = pathFromTipHash(localClassicForkTip.hash);
      if (path && path.length >= main.length) return path;
    }
    return main.slice();
  }

  // NEW side: path to sticky NEW tip (shared history + NEW blocks)
  refreshLocalNewForkTip();
  if (localNewForkTip && localNewForkTip.hash) {
    const path = pathFromTipHash(localNewForkTip.hash);
    if (path && path.length) return path;
  }
  // Fall back: main up through activation parent only
  const act = Number(pendingForkHeight);
  return main.filter(function (b) {
    return !b || b.index == null || Number(b.index) < act || !isNewForkId(b.forkId);
  }).filter(function (b) {
    // drop any NEW that snuck onto main
    return b && !isNewForkId(b.forkId);
  });
}

function pathFromTipHash(tipHash) {
  if (!tipHash) return null;
  const all = collectKnownBlocks();
  const path = [];
  const seen = new Set();
  let cur = all.get(tipHash);
  while (cur && cur.hash && !seen.has(cur.hash)) {
    seen.add(cur.hash);
    path.unshift(cur);
    if (
      cur.index === 0 ||
      cur.previousHash === '0' ||
      cur.miner === 'genesis'
    ) {
      return path;
    }
    cur = all.get(cur.previousHash);
    if (!cur) break;
  }
  return path.length ? path : null;
}

function updateParticipantBlockchainView(chainData, participants) {
  const parts = rememberParticipants(participants);
  // Prefer explicit chain if provided and non-empty; otherwise personal/fork-aware path
  let blocks =
    chainData && Array.isArray(chainData.chain) && chainData.chain.length
      ? chainData.chain
      : getPersonalChainBlocks();
  // When caller passes hub main during a NEW choice, replace with personal path
  if (myForkChoice === 'new' && pendingForkHeight != null) {
    const personal = getPersonalChainBlocks();
    if (personal && personal.length) blocks = personal;
  }

  const CD = window.ChainDisplay;
  const nameLookup = CD ? CD.buildParticipantNameLookup(parts) : {};
  const fmtAddr = (addr) => (CD ? CD.formatChainParticipantHtml(addr, nameLookup) : `<code>${addr || ''}</code>`);

  if (blocks.length > 0) {
    localChainTipHash = blocks[blocks.length - 1].hash;
  }

  const sideNote =
    myForkChoice === 'new' && pendingForkHeight != null
      ? ' <span class="label label-info">Following NEW chain</span>'
      : '';
  let html =
    '<h4>Your Blockchain Copy (Height: ' +
    Math.max(0, blocks.length ? (blocks[blocks.length - 1].index != null ? blocks[blocks.length - 1].index : blocks.length - 1) : 0) +
    ')' +
    sideNote +
    '</h4>';

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const highlight = block.miner === userId ? 'panel-success' : 'panel-default';
    const minerId = block.miner != null ? block.miner : '';

    let txHtml = `${block.transactions ? block.transactions.length : 0}`;
    if (block.transactions && block.transactions.length > 0) {
      txHtml += ' <button class="btn btn-xs btn-default" onclick="toggleTransactions(\'personal_' + i + '\')">View Details</button>';
      const displayStyle = openTxPanels.has('personal_' + i) ? 'block' : 'none';
      txHtml += '<div id="txDetails_personal_' + i + '" style="display:' + displayStyle + '; margin-top: 10px;">';
      txHtml += '<table class="table table-condensed">';
      txHtml += '<thead><tr><th>From</th><th>To</th><th>Amount</th><th>Time</th></tr></thead><tbody>';

      for (const tx of block.transactions) {
        const timeStr = tx.timestamp ? new Date(tx.timestamp).toLocaleTimeString() : '-';
        txHtml += `<tr>`;
        txHtml += `<td>${fmtAddr(tx.from)}</td>`;
        txHtml += `<td>${fmtAddr(tx.to)}</td>`;
        txHtml += `<td>${tx.amount} coins</td>`;
        txHtml += `<td>${timeStr}</td>`;
        txHtml += `</tr>`;
      }

      txHtml += '</tbody></table></div>';
    }

    const forkBadge =
      block.forkId && block.forkId !== 'classic'
        ? `<span class="label label-info pull-right">${String(block.forkId).toUpperCase()} CHAIN</span>`
        : '';
    html += `
      <div class="panel ${highlight}">
        <div class="panel-heading">
            <strong>Block #${block.index}</strong> ${forkBadge}
          <span class="pull-right text-muted small">${new Date(block.timestamp).toLocaleTimeString()}</span>
        </div>
        <div class="panel-body">
          <dl class="dl-horizontal chain-block-dl">
            <dt>Hash</dt>
            <dd><code style="font-size: 10px; word-break: break-all;">${block.hash}</code></dd>
            <dt>Previous Hash</dt>
            <dd><code style="font-size: 10px; word-break: break-all;">${block.previousHash}</code></dd>
            <dt>Miner</dt>
            <dd>${fmtAddr(minerId)}</dd>
            <dt>Nonce</dt>
            <dd>${block.nonce}</dd>
            <dt>Transactions</dt>
            <dd>${txHtml}</dd>
          </dl>
        </div>
      </div>
    `;
  }

  $('#blockchainView').html(html || '<p class="text-muted">No blocks yet</p>');
}

function updateNetworkBlockchainView(mainChain, orphans, participants) {
  const main = mainChain || window.lastRelayedChain || [];
  const parts = rememberParticipants(participants);
  // Always prefer the accumulated orphan set so Shared Network shows forks
  const orphanList = (orphans && orphans.length)
    ? orphans
    : getDisplayOrphans();
  if (window.ChainDisplay && typeof ChainDisplay.renderChainHtml === 'function') {
    let html = ChainDisplay.renderChainHtml({
      mainChain: main,
      orphans: orphanList,
      participants: parts,
      openTxPanels: openTxPanels
    });
    const newSide = (orphanList || []).filter(function (b) {
      return b && (b.forkId === 'new' || b.forkId === 'NEW');
    }).length;
    const otherSide = (orphanList || []).length - newSide;
    if (orphanList && orphanList.length) {
      let caption =
        'Shared network: <strong>classic main</strong>';
      if (newSide > 0) {
        caption +=
          ' + <strong>' + newSide + '</strong> block(s) on the <strong>NEW</strong> hard-fork chain';
      }
      if (otherSide > 0) {
        caption +=
          (newSide > 0 ? ';' : ' +') +
          ' <strong>' +
          otherSide +
          '</strong> competing/orphan block(s)';
      }
      caption += '.';
      html =
        '<p class="small text-muted" style="margin-bottom:8px;">' + caption + '</p>' + html;
    } else {
      html =
        '<p class="small text-muted" style="margin-bottom:8px;">' +
        'Shared network view (main chain). Hard-fork side chains and race orphans appear beside it.</p>' +
        html;
    }
    $('#networkBlockchainView').html(html);
    return;
  }
  $('#networkBlockchainView').html('<p class="text-muted">No blocks yet</p>');
}

function toggleTransactions(blockIndex) {
  const $el = $('#txDetails_' + blockIndex);
  $el.toggle();
  if ($el.is(':visible')) {
    openTxPanels.add(blockIndex.toString());
  } else {
    openTxPanels.delete(blockIndex.toString());
  }
}

// Legacy sync functions removed (no server in client-relay mode; chain sync handled via relayed state from admin)


function updateParticipantList(blockchain) {
  if (blockchain && Array.isArray(blockchain.participants) && blockchain.participants.length) {
    rememberParticipants(blockchain.participants);
  }
  const participants = (lastKnownParticipants || blockchain.participants || []).filter(function (p) {
    const id = p.userId || p.address || p.id || '';
    return id && String(id).indexOf('probe-') !== 0;
  }).slice().sort(function (a, b) {
    const roleRank = function (p) {
      const r = String(p.role || 'miner').toLowerCase();
      if (r === 'wallet' || r === 'observer') return 0;
      if (r === 'miner') return 1;
      if (r === 'admin' || r === 'hub') return 3;
      return 2;
    };
    const aSelf = (a.userId || a.address) === userId ? 1 : 0;
    const bSelf = (b.userId || b.address) === userId ? 1 : 0;
    if (aSelf !== bSelf) return aSelf - bSelf;
    return roleRank(a) - roleRank(b);
  });
  let html = '';

  participants.forEach(p => {
    const addr = p.userId || p.address || p.id || '';
    const mined = p.blocksMined != null ? p.blocksMined : (p.minedBlocks || 0);
    const bal = p.balance != null ? p.balance : 0;
    const role = String(p.role || 'miner').toLowerCase();
    const roleLabel = (role === 'wallet' || role === 'observer')
      ? '<span class="label label-info">Wallet</span>'
      : (role === 'admin' || role === 'hub'
        ? '<span class="label label-warning">Admin</span>'
        : '<span class="label label-success">Miner</span>');
    const displayName = (p.displayName || p.name || '').trim();
    const nameHtml = displayName
      ? `<strong style="display: block; margin-top: 4px;">${escapeHtml(displayName)}</strong>`
      : '';
    const isSelf = addr && userId && addr === userId;
    const selfBadge = isSelf ? ' <span class="label label-default">You</span>' : '';
    const sendBtn = (!isSelf && addr)
      ? `<button type="button" class="btn btn-xs btn-primary use-recipient-btn" data-address="${escapeHtml(addr)}" title="Fill send form with this address" style="margin-left: 4px;">Send to</button>`
      : '';
    const copyBtn = addr
      ? `<button type="button" class="btn btn-xs btn-default copy-btn" data-clipboard-text="${escapeHtml(addr)}" title="Copy address">Copy</button>`
      : '';

    html += `<li class="list-group-item" style="padding: 8px 10px;">
      <div>${roleLabel}${selfBadge}
        <span class="pull-right">${copyBtn}${sendBtn}</span>
      </div>
      ${nameHtml}
      <div style="margin-top: 4px; clear: both;">
        <code class="participant-address" style="font-size: 10px; word-break: break-all; display: block;">${escapeHtml(addr)}</code>
      </div>
      <span class="text-muted small" style="margin-top: 4px; display: inline-block;">${mined} blocks · ${bal} coins</span>
    </li>`;
  });

  if (participants.length === 0) {
    html = '<li class="list-group-item text-muted"><em>Waiting for miners and wallets...</em></li>';
  }

  $('#participantList').html(html);
  $('#participantDirectory').html(html);
}

function updatePendingTransactions(blockchain) {
  const transactions = blockchain.pendingTransactions || [];
  const CD = window.ChainDisplay;
  const nameLookup = CD ? CD.buildParticipantNameLookup(blockchain.participants || []) : {};
  const fmtAddr = (addr) => (CD ? CD.formatChainParticipantHtml(addr, nameLookup) : `<code>${addr || ''}</code>`);
  let html = '';

  transactions.forEach(tx => {
    html += `
      <tr>
        <td>${fmtAddr(tx.from)}</td>
        <td>${fmtAddr(tx.to)}</td>
        <td><strong>${tx.amount}</strong></td>
        <td>${tx.timestamp ? new Date(tx.timestamp).toLocaleTimeString() : '—'}</td>
      </tr>
    `;
  });

  if (transactions.length === 0) {
    html = '<tr><td colspan="4" class="text-center text-muted">No pending transactions</td></tr>';
  }

  $('#pendingTransactions').html(html);
  const $badge = $('#mempoolCountBadge');
  if ($badge.length) {
    $badge.text(String(transactions.length));
    $badge
      .toggleClass('label-default', transactions.length === 0)
      .toggleClass('label-warning', transactions.length > 0);
  }
}

function updateNetworkStats(blockchain) {
  const stats = blockchain.networkStats || {};
  let height = stats.blockHeight;
  if (height == null && Array.isArray(blockchain.chain) && blockchain.chain.length > 0) {
    height = Math.max(0, blockchain.chain.length - 1);
  }
  if (height == null && window.lastRelayedChain && window.lastRelayedChain.length > 0) {
    height = Math.max(0, window.lastRelayedChain.length - 1);
  }
  if (height == null) height = 0;
  $('#blockHeight').text(height);
  $('#participantCount').text(blockchain.participants ? blockchain.participants.length : 0);
  $('#totalHashrate').text((stats.totalHashrate || 0).toFixed(0) + ' H/s');
}

function updateDifficultyInfo(settings) {
  const zeros = (settings.difficultyLeading != null ? settings.difficultyLeading : 1);
  const secondary = (settings.difficultySecondary != null ? settings.difficultySecondary : 8).toString(16).toUpperCase();
  let label = zeros + ' + 0x' + secondary;
  if (settings.targetBlockTimeSec) {
    label += ' (~' + settings.targetBlockTimeSec + 's target)';
  }
  if (settings.autoDifficulty) label += ' auto';
  $('#difficultyLevel').text(label);
}

// Check if hash meets difficulty requirement
function isValidHash(hash, difficulty) {
  if (window.customValidator) {
    if (window.customValidator._broken) return false; // Force failure if they broke the code
    try {
      const result = window.customValidator.validateDifficulty(hash, difficulty);
      return result && result.valid === true;
    } catch (e) {
      return false; // Broken logic causes hashing to fail forever
    }
  }
  
  if (difficulty == null) return false;
  if (typeof difficulty === 'number') {
    difficulty = { leadingZeros: Math.max(1, Math.floor(difficulty)), secondaryHex: 'F' };
  }
  if (typeof difficulty !== 'object') return false;
  
  const zeros = difficulty.leadingZeros != null ? difficulty.leadingZeros : 3;
  for (let i = 0; i < zeros; i++) {
    if (hash[i] !== '0') return false;
  }
  
  // Check secondary difficulty constraint to match backend logic
  if (difficulty.secondaryHex != null && String(difficulty.secondaryHex) !== '') {
    const nextChar = hash.charAt(zeros);
    if (nextChar && nextChar.toLowerCase() > String(difficulty.secondaryHex).toLowerCase()) return false;
  }
  
  return true;
}

