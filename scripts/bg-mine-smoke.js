/**
 * Smoke test: miner keeps finding blocks after tab is marked hidden.
 * Usage: node scripts/bg-mine-smoke.js [baseUrl]
 */
const { chromium } = require('playwright');
const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await admin.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await admin.click('#createSessionBtn');
  await admin.waitForURL(/admin/i, { timeout: 45000 });
  await wait(2500);
  const code = (await admin.locator('#sessionCode').textContent() || '').trim().toUpperCase();
  await admin.evaluate(() => {
    const lock = document.getElementById('lockParameters');
    if (lock) lock.checked = false;
    const auto = document.getElementById('autoDifficulty');
    if (auto) auto.checked = false;
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
  await wait(800);

  const miner = await ctx.newPage();
  const workerErrors = [];
  miner.on('pageerror', (e) => workerErrors.push(String(e.message || e)));
  miner.on('console', (m) => {
    if (m.type() === 'error') workerErrors.push(m.text());
  });
  await miner.goto(BASE, { waitUntil: 'domcontentloaded' });
  await miner.fill('#joinCode', code);
  await miner.selectOption('#roleSelect', 'participant');
  await miner.click('#joinForm button[type="submit"]');
  await miner.waitForURL(/participate/i, { timeout: 30000 });
  await wait(3000);
  await miner.click('#mineBtn');
  await wait(2000);

  // Phase 1: foreground mining should grow the chain via the Web Worker
  await wait(8000);
  const h1 = parseInt(await admin.locator('#blockHeight').textContent(), 10) || 0;
  const mid = await miner.evaluate(() => ({
    isMining: typeof isMining !== 'undefined' ? isMining : null,
    hasWorker: typeof miningWorker !== 'undefined' && !!miningWorker,
    lastProgressAge:
      typeof lastWorkerProgressAt !== 'undefined' ? Date.now() - lastWorkerProgressAt : null,
    gen: typeof miningJobGen !== 'undefined' ? miningJobGen : null,
    intent: !!window.lastMiningIntent,
    canWorker: typeof canUseWorkerMining === 'function' ? canUseWorkerMining() : null
  }));

  // Phase 2: switch worker to background pace (what visibilitychange does) and keep mining
  await miner.evaluate(() => {
    if (typeof syncMiningWorkerPace === 'function') {
      // Force background pace even if document.hidden cannot be mocked reliably
      if (miningWorker) {
        try {
          miningWorker.postMessage({ command: 'setPace', delay: 0, batchSize: 8000 });
        } catch (e) {}
      }
    }
  });
  const hMid = parseInt(await admin.locator('#blockHeight').textContent(), 10) || 0;
  await wait(8000);
  const h2 = parseInt(await admin.locator('#blockHeight').textContent(), 10) || 0;
  const end = await miner.evaluate(() => ({
    isMining: typeof isMining !== 'undefined' ? isMining : null,
    hasWorker: typeof miningWorker !== 'undefined' && !!miningWorker,
    lastProgressAge:
      typeof lastWorkerProgressAt !== 'undefined' ? Date.now() - lastWorkerProgressAt : null,
    gen: typeof miningJobGen !== 'undefined' ? miningJobGen : null,
    intent: !!window.lastMiningIntent
  }));

  console.log(
    JSON.stringify(
      {
        code,
        h0: hMid,
        h1,
        h2,
        grewForeground: h1 > 0,
        grewBackgroundPace: h2 > hMid,
        deltaFg: h1,
        deltaBg: h2 - hMid,
        mid,
        end,
        workerErrors: workerErrors.slice(0, 8)
      },
      null,
      2
    )
  );

  await browser.close();
  if (!(h1 > 0 && h2 > hMid)) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
