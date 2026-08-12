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
    // Disable auto difficulty if present
    const auto = document.getElementById('autoDifficulty');
    if (auto) auto.checked = false;
  });
  await admin.click('#updateSettingsBtn');
  await wait(500);

  const miner = await ctx.newPage();
  const msgs = [];
  miner.on('console', (m) => {
    if (/worker|found|progress|Mining|error/i.test(m.text())) msgs.push(m.text().slice(0, 180));
  });
  await miner.goto(BASE);
  await miner.fill('#joinCode', code);
  await miner.selectOption('#roleSelect', 'participant');
  await miner.click('#joinForm button[type=submit]');
  await miner.waitForURL(/participate/i, { timeout: 30000 });
  await wait(3500);

  // Hook worker messages
  await miner.evaluate(() => {
    window.__wmsgs = [];
    const _ensure = ensureMiningWorker;
    ensureMiningWorker = function () {
      const w = _ensure();
      if (w && !w.__hooked) {
        w.__hooked = true;
        const prev = w.onmessage;
        w.onmessage = function (ev) {
          try {
            window.__wmsgs.push(ev.data && ev.data.type);
            if (window.__wmsgs.length > 40) window.__wmsgs.shift();
          } catch (e) {}
          if (prev) return prev.call(this, ev);
        };
      }
      return w;
    };
  });

  await miner.click('#mineBtn');
  await wait(8000);

  const out = await miner.evaluate(() => ({
    wmsgs: window.__wmsgs || [],
    gen: miningJobGen,
    isMining: isMining,
    hasWorker: !!miningWorker,
    failed: miningWorkerFailed,
    progressAge: Date.now() - lastWorkerProgressAt,
    hubH: hubConfirmedHeight,
    tip: window.lastRelayedChain && window.lastRelayedChain.length
      ? window.lastRelayedChain[window.lastRelayedChain.length - 1].index
      : null,
    cur: currentMiningBlock && {
      index: currentMiningBlock.index,
      diff: currentMiningBlock.difficulty
    },
    customFlag: !!window.__labValidatorIsCustom,
    canWorker: canUseWorkerMining()
  }));
  console.log(JSON.stringify(out, null, 2));
  console.log('adminH', await admin.locator('#blockHeight').textContent());
  console.log('msgs', msgs.slice(0, 20));
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
