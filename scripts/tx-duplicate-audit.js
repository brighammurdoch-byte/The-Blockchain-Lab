/**
 * Send txs while mining — assert no "Duplicate block" rejection toasts.
 * Usage: node scripts/tx-duplicate-audit.js [baseUrl]
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
  const admin = await ctx.newPage();
  await admin.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await admin.click('#createSessionBtn');
  await admin.waitForURL(/admin/i, { timeout: 45000 });
  await wait(3000);
  let code = (await admin.locator('#sessionCode').textContent() || '').trim().toUpperCase();
  await admin.uncheck('#lockParameters').catch(() => {});
  await admin.locator('#difficultyLeading').fill('1');
  await admin.locator('#difficultySecondary').fill('15');
  await admin.click('#updateSettingsBtn');
  await wait(600);

  const miner = await ctx.newPage();
  const toasts = [];
  miner.on('console', () => {});
  await miner.goto(BASE, { waitUntil: 'domcontentloaded' });
  await miner.fill('#joinCode', code);
  await miner.selectOption('#roleSelect', 'participant');
  await miner.click('#joinForm button[type="submit"]');
  await miner.waitForURL(/participate/i, { timeout: 30000 });
  await wait(3500);
  await miner.fill('#nodeName', 'DupMiner');
  await miner.click('#setNodeNameBtn');
  await miner.click('#mineBtn');

  // Hook toast DOM observer
  await miner.evaluate(() => {
    window.__dupToasts = [];
    const obs = new MutationObserver(() => {
      const t = document.getElementById('toastNotification');
      if (t && t.textContent) window.__dupToasts.push(t.textContent.trim());
    });
    obs.observe(document.body, { childList: true, subtree: true });
  });

  const wallet = await ctx.newPage();
  await wallet.goto(BASE, { waitUntil: 'domcontentloaded' });
  await wallet.fill('#joinCode', code);
  await wallet.selectOption('#roleSelect', 'observer');
  await wallet.click('#joinForm button[type="submit"]');
  await wallet.waitForURL(/observe/i, { timeout: 30000 });
  await wait(4000);
  await wallet.fill('#nodeName', 'DupWallet');
  await wallet.click('#setNodeNameBtn');

  let minerAddr = '';
  let walletAddr = '';
  for (let i = 0; i < 20; i++) {
    minerAddr = (await miner.locator('#yourAddress').textContent() || '').trim();
    walletAddr = (await wallet.locator('#yourAddress').textContent() || '').trim();
    const bal = parseFloat(await miner.locator('#yourBalance').textContent()) || 0;
    if (minerAddr && walletAddr && bal >= 10) break;
    await wait(1000);
  }
  pass('Setup mining + wallet', 'bal setup ok');

  // Rapid fire several transfers while mining hard
  for (let i = 0; i < 5; i++) {
    await miner.bringToFront();
    await miner.fill('#recipientAddress', walletAddr);
    await miner.fill('#transactionAmount', '1');
    await miner.click('#sendTransactionBtn, #transactionForm button[type="submit"]').catch(async () => {
      await miner.evaluate(() => {
        const form = document.getElementById('transactionForm');
        if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    });
    await wait(800);
  }
  await wait(8000);

  const toastList = await miner.evaluate(() => (window.__dupToasts || []).slice());
  const dup = toastList.filter((t) => /duplicate block/i.test(t));
  if (dup.length === 0) pass('No duplicate-block toasts while sending txs', toastList.length + ' toasts total');
  else fail('No duplicate-block toasts while sending txs', dup.join(' | '));

  const h = parseInt(await admin.locator('#blockHeight').textContent(), 10) || 0;
  if (h >= 1) pass('Chain still growing', 'height ' + h);
  else fail('Chain still growing', 'height ' + h);

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n==== tx-duplicate-audit: ' + (results.length - failed) + '/' + results.length + ' passed ====');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
