/**
 * Admin has a wallet UI with starter balance and can send to a student.
 * Usage: node scripts/admin-wallet-audit.js [baseUrl]
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

  const addr = (await admin.locator('#yourAddress').textContent() || '').trim();
  if (addr && addr !== 'Loading...' && addr.length > 3) pass('Admin address shown', addr.slice(0, 24));
  else fail('Admin address shown', addr);

  const bal = parseFloat(await admin.locator('#yourBalance').textContent()) || 0;
  if (bal >= 100) pass('Admin starter balance', String(bal));
  else fail('Admin starter balance', String(bal));

  if (await admin.locator('#transactionForm').count()) pass('Send form present');
  else fail('Send form present', 'missing');

  const code = (await admin.locator('#sessionCode').textContent() || '').trim().toUpperCase();
  await admin.uncheck('#lockParameters').catch(() => {});
  await admin.locator('#difficultyLeading').fill('1');
  await admin.locator('#difficultySecondary').fill('15');
  await admin.click('#updateSettingsBtn');
  await wait(400);

  const wallet = await ctx.newPage();
  await wallet.goto(BASE, { waitUntil: 'domcontentloaded' });
  await wallet.fill('#joinCode', code);
  await wallet.selectOption('#roleSelect', 'observer');
  await wallet.click('#joinForm button[type="submit"]');
  await wallet.waitForURL(/observe/i, { timeout: 30000 });
  await wait(3500);
  await wallet.fill('#nodeName', 'FundMe');
  await wallet.click('#setNodeNameBtn');
  let walletAddr = '';
  for (let i = 0; i < 15; i++) {
    walletAddr = (await wallet.locator('#yourAddress').textContent() || '').trim();
    if (walletAddr && walletAddr !== 'Loading...') break;
    await wait(500);
  }

  const miner = await ctx.newPage();
  await miner.goto(BASE, { waitUntil: 'domcontentloaded' });
  await miner.fill('#joinCode', code);
  await miner.selectOption('#roleSelect', 'participant');
  await miner.click('#joinForm button[type="submit"]');
  await miner.waitForURL(/participate/i, { timeout: 30000 });
  await wait(2500);
  await miner.click('#mineBtn');

  await admin.bringToFront();
  await admin.fill('#recipientAddress', walletAddr);
  await admin.fill('#transactionAmount', '5');
  await admin.click('#transactionForm button[type="submit"]');
  await wait(1500);

  // Wait for inclusion
  let got = false;
  for (let i = 0; i < 45; i++) {
    const wb = parseFloat(await wallet.locator('#yourBalance').textContent()) || 0;
    if (wb >= 5) { got = true; pass('Wallet received admin transfer', String(wb)); break; }
    await wait(1000);
  }
  if (!got) fail('Wallet received admin transfer', 'balance still low');

  const adminAfter = parseFloat(await admin.locator('#yourBalance').textContent()) || 0;
  if (adminAfter <= bal - 5 + 0.01) pass('Admin balance decreased after confirm', bal + ' → ' + adminAfter);
  else fail('Admin balance decreased after confirm', bal + ' → ' + adminAfter);

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n==== admin-wallet-audit: ' + (results.length - failed) + '/' + results.length + ' passed ====');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
