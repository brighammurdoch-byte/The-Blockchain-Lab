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
  const logs = [];
  miner.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
  miner.on('pageerror', (e) => logs.push('PE: ' + e.message));
  await miner.goto(BASE);
  await miner.fill('#joinCode', code);
  await miner.selectOption('#roleSelect', 'participant');
  await miner.click('#joinForm button[type=submit]');
  await miner.waitForURL(/participate/i, { timeout: 30000 });
  await wait(3000);

  const urls = await miner.evaluate(() => {
    const asset = (p) =>
      window.LabPaths && LabPaths.assetUrl ? LabPaths.assetUrl(p) : p;
    const abs = (p) => {
      try {
        return new URL(asset(p), location.href).href;
      } catch (e) {
        return asset(p);
      }
    };
    return {
      href: location.href,
      base: window.LabPaths && LabPaths.getBasePath && LabPaths.getBasePath(),
      worker: abs('/javascripts/lab/miningWorker.js') + '?v=bgmine1',
      sha: abs('/javascripts/lib/sha256.js'),
      canWorker: typeof Worker !== 'undefined',
      custom: !!(window.customValidator && !window.customValidator._broken)
    };
  });
  console.log('urls', JSON.stringify(urls, null, 2));

  const wtest = await miner.evaluate(async ({ workerUrl, shaUrl }) => {
    return await new Promise((resolve) => {
      let w;
      try {
        w = new Worker(workerUrl);
      } catch (e) {
        resolve({ err: 'construct ' + e.message });
        return;
      }
      const t = setTimeout(() => resolve({ err: 'timeout' }), 4000);
      w.onmessage = (ev) => {
        if (ev.data && ev.data.type === 'ready') {
          clearTimeout(t);
          resolve({ ok: true, ready: true });
          w.terminate();
        }
        if (ev.data && ev.data.type === 'error') {
          clearTimeout(t);
          resolve({ err: ev.data.message });
          w.terminate();
        }
      };
      w.onerror = (e) => {
        clearTimeout(t);
        resolve({ err: e.message, file: e.filename, line: e.lineno });
      };
      w.postMessage({ command: 'init', sha256Url: shaUrl });
    });
  }, { workerUrl: urls.worker, shaUrl: urls.sha });
  console.log('wtest', JSON.stringify(wtest));

  await miner.click('#mineBtn');
  await wait(5000);
  const st = await miner.evaluate(() => ({
    isMining: isMining,
    hasWorker: !!miningWorker,
    failed: miningWorkerFailed,
    gen: miningJobGen,
    progressAge: Date.now() - lastWorkerProgressAt,
    workerUrl: typeof getMiningWorkerScriptUrl === 'function' ? getMiningWorkerScriptUrl() : null,
    shaUrl: typeof getSha256ScriptUrl === 'function' ? getSha256ScriptUrl() : null
  }));
  console.log('state', JSON.stringify(st, null, 2));
  console.log(
    'logs',
    logs.filter((l) => /worker|Mining|error|Error|fail/i.test(l)).slice(0, 40)
  );
  const h = parseInt(await admin.locator('#blockHeight').textContent(), 10) || 0;
  console.log('height', h);
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
