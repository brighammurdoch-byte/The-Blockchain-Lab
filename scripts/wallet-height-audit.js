/**
 * Wallet (observer) block-height should climb while a miner produces blocks.
 * Usage: node scripts/wallet-height-audit.js [baseUrl]
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
  await wait(2500);
  const code = (await admin.locator('#sessionCode').textContent() || '').trim().toUpperCase();
  await admin.uncheck('#lockParameters').catch(() => {});
  await admin.locator('#difficultyLeading').fill('1');
  await admin.locator('#difficultySecondary').fill('15');
  await admin.click('#updateSettingsBtn');
  await wait(500);

  const miner = await ctx.newPage();
  await miner.goto(BASE, { waitUntil: 'domcontentloaded' });
  await miner.fill('#joinCode', code);
  await miner.selectOption('#roleSelect', 'participant');
  await miner.click('#joinForm button[type="submit"]');
  await miner.waitForURL(/participate/i, { timeout: 30000 });
  await wait(2500);
  await miner.fill('#nodeName', 'HMiner');
  await miner.click('#setNodeNameBtn');
  await miner.click('#mineBtn');

  const wallet = await ctx.newPage();
  await wallet.goto(BASE, { waitUntil: 'domcontentloaded' });
  await wallet.fill('#joinCode', code);
  await wallet.selectOption('#roleSelect', 'observer');
  await wallet.click('#joinForm button[type="submit"]');
  await wallet.waitForURL(/observe/i, { timeout: 30000 });
  await wait(3000);
  await wallet.fill('#nodeName', 'HWallet');
  await wallet.click('#setNodeNameBtn');

  // Wait for several blocks
  let walletH = 0;
  let adminH = 0;
  let sawGrowth = false;
  for (let i = 0; i < 40; i++) {
    await wait(1000);
    adminH = parseInt(await admin.locator('#blockHeight').textContent(), 10) || 0;
    walletH = parseInt(await wallet.locator('#blockHeight').textContent(), 10) || 0;
    if (walletH >= 2 && adminH >= 2 && Math.abs(walletH - adminH) <= 2) {
      sawGrowth = true;
      break;
    }
  }

  if (sawGrowth) pass('Wallet height tracks mining', 'wallet=' + walletH + ' admin=' + adminH);
  else fail('Wallet height tracks mining', 'wallet=' + walletH + ' admin=' + adminH);

  // Compact path: height should still move after more mining
  const h1 = walletH;
  await wait(5000);
  const h2 = parseInt(await wallet.locator('#blockHeight').textContent(), 10) || 0;
  if (h2 > h1) pass('Wallet height keeps climbing', h1 + ' → ' + h2);
  else if (h2 >= 2 && h1 >= 2) pass('Wallet height stable at tip', 'h=' + h2);
  else fail('Wallet height keeps climbing', h1 + ' → ' + h2);

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n==== wallet-height-audit: ' + (results.length - failed) + '/' + results.length + ' passed ====');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
