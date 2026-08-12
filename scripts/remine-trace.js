const { chromium } = require('playwright');
const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext();
  const admin = await ctx.newPage();
  await admin.goto(BASE, { waitUntil: 'domcontentloaded' });
  await admin.click('#createSessionBtn');
  await admin.waitForURL(/admin/i, { timeout: 45000 });
  await wait(2000);
  const code = (await admin.locator('#sessionCode').textContent() || '').trim().toUpperCase();
  await admin.evaluate(() => {
    const lock = document.getElementById('lockParameters');
    if (lock) lock.checked = false;
    const lead = document.getElementById('difficultyLeading');
    const sec = document.getElementById('difficultySecondary');
    if (lead) {
      lead.disabled = false;
      lead.value = '1';
    }
    if (sec) {
      sec.disabled = false;
      sec.value = '15';
    }
  });
  await admin.click('#updateSettingsBtn');

  const miner = await ctx.newPage();
  miner.on('console', (m) => {
    const t = m.text();
    if (/Mine|worker|found|reject|error|Remine|silent|Broadcast|Block/i.test(t)) {
      console.log('M', m.type(), t.slice(0, 220));
    }
  });
  await miner.goto(BASE);
  await miner.fill('#joinCode', code);
  await miner.selectOption('#roleSelect', 'participant');
  await miner.click('#joinForm button[type=submit]');
  await miner.waitForURL(/participate/i, { timeout: 30000 });
  await wait(3000);

  await miner.evaluate(() => {
    window.__mineLog = [];
    function wrap(name, fn) {
      return function () {
        window.__mineLog.push(name + ':' + Date.now());
        if (window.__mineLog.length > 80) window.__mineLog.shift();
        return fn.apply(this, arguments);
      };
    }
    remineOnCanonicalTip = wrap('remine', remineOnCanonicalTip);
    fetchDataAndMine = wrap('fetch', fetchDataAndMine);
    startWorkerMiningJob = wrap('job', startWorkerMiningJob);
  });

  await miner.click('#mineBtn');
  await wait(6000);

  const out = await miner.evaluate(() => ({
    log: window.__mineLog.slice(-40),
    counts: window.__mineLog.reduce((a, x) => {
      const k = x.split(':')[0];
      a[k] = (a[k] || 0) + 1;
      return a;
    }, {}),
    gen: miningJobGen,
    isMining: isMining,
    hasWorker: !!miningWorker,
    height: (window.lastRelayedChain || []).length,
    tip:
      window.lastRelayedChain && window.lastRelayedChain.length
        ? window.lastRelayedChain[window.lastRelayedChain.length - 1].index
        : null,
    cur: currentMiningBlock && {
      index: currentMiningBlock.index,
      prev: String(currentMiningBlock.previousHash || '').slice(0, 12),
      fork: currentMiningBlock.forkId
    },
    diff: getMiningDifficulty(),
    custom: !!window.__labValidatorIsCustom,
    failed: miningWorkerFailed
  }));
  console.log(JSON.stringify(out, null, 2));
  console.log('adminH', await admin.locator('#blockHeight').textContent());
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
