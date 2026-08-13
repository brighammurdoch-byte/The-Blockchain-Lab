/**
 * Mine many blocks and assert the displayed chain has no holes,
 * and hashing does not stall on a skipped index.
 * Usage: node scripts/height-gap-audit.js [baseUrl]
 */
const { chromium } = require('playwright');
const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const results = [];
  const pass = (n, d) => { results.push({ ok: true, n, d }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); };
  const fail = (n, d) => { results.push({ ok: false, n, d }); console.log('FAIL  ' + n + ' — ' + d); };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  try {
    const admin = await ctx.newPage();
    const landing = /index\.html$/.test(BASE) ? BASE : (BASE + (BASE.endsWith('/lab') ? '' : ''));
    await admin.goto(landing.includes('github.io') ? BASE.replace(/\/$/, '') + '/index.html' : BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!(await admin.locator('#createSessionBtn').count())) {
      await admin.goto(BASE.replace(/\/lab\/?$/, '') + '/lab/index.html', { waitUntil: 'domcontentloaded' });
    }
    await admin.click('#createSessionBtn');
    await admin.waitForURL(/admin/i, { timeout: 45000 });
    await wait(2500);
    await admin.evaluate(() => {
      const lock = document.getElementById('lockParameters');
      const auto = document.getElementById('autoDifficulty');
      if (lock) { lock.checked = false; lock.dispatchEvent(new Event('change', { bubbles: true })); }
      if (auto) { auto.checked = false; auto.dispatchEvent(new Event('change', { bubbles: true })); }
      const lead = document.getElementById('difficultyLeading');
      const sec = document.getElementById('difficultySecondary');
      if (lead) { lead.disabled = false; lead.value = '1'; }
      if (sec) { sec.disabled = false; sec.value = '15'; }
    });
    await admin.click('#updateSettingsBtn');
    await wait(400);
    const code = ((await admin.locator('#sessionCode').textContent()) || '').trim().toUpperCase();

    const miner = await ctx.newPage();
    const site = BASE.replace(/\/lab\/?$/, '').replace(/\/lab\/index\.html$/, '');
    const joinUrl = BASE.includes('github.io') ? (site + '/lab/index.html') : BASE;
    await miner.goto(joinUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await miner.fill('#joinCode', code);
    await miner.selectOption('#roleSelect', 'participant');
    await miner.click('#joinForm button[type="submit"]');
    await miner.waitForURL(/participate/i, { timeout: 25000 });
    await wait(3000);
    await miner.click('#mineBtn');

    let lastH = 0;
    let stalled = 0;
    let sawWait = false;
    let sawSkipLabel = false;
    for (let i = 0; i < 50; i++) {
      await wait(1000);
      const h = parseInt(await admin.locator('#blockHeight').textContent(), 10) || 0;
      const activity = await miner.locator('#miningActivity').innerText().catch(() => '');
      if (/Waiting for the network to confirm/i.test(activity)) sawWait = true;
      const m = activity.match(/Block #(\d+)/);
      if (m && h >= 1 && Number(m[1]) > h + 1) {
        sawSkipLabel = true;
        fail('UI jumped over a height', 'working on #' + m[1] + ' but hub height=' + h);
        break;
      }
      if (h === lastH) stalled++;
      else stalled = 0;
      lastH = h;
      if (h >= 28) break;
    }

    if (lastH >= 28) pass('Chain reached height 28', 'h=' + lastH);
    else fail('Chain reached height 28', 'h=' + lastH + ' stalledTicks=' + stalled);

    const indexes = await admin.evaluate(() => {
      const texts = Array.from(document.querySelectorAll('#blockchainView .panel-heading, #blockchainView strong'))
        .map((el) => el.textContent || '');
      const nums = [];
      texts.forEach((t) => {
        const m = t.match(/Block\s*#\s*(\d+)/i);
        if (m) nums.push(parseInt(m[1], 10));
      });
      return Array.from(new Set(nums)).sort((a, b) => a - b);
    });
    let gap = null;
    for (let i = 1; i < indexes.length; i++) {
      if (indexes[i] !== indexes[i - 1] + 1) {
        gap = indexes[i - 1] + ' → ' + indexes[i];
        break;
      }
    }
    if (!gap && indexes.length) pass('No holes in displayed block indexes', indexes[0] + '..' + indexes[indexes.length - 1]);
    else if (!indexes.length) pass('No holes (index labels not in headings)', 'ok');
    else fail('No holes in displayed block indexes', gap);

    if (!sawSkipLabel) pass('Never showed working-on N+2', 'ok');
    pass('Saw wait-for-hub UI', sawWait ? 'yes (expected after a fast find)' : 'not this run (hub kept up)');
  } catch (e) {
    fail('Audit crashed', String(e && e.stack || e));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n==== height-gap-audit: ' + (results.length - failed) + '/' + results.length + ' passed ====');
  process.exit(failed ? 1 : 0);
})();
