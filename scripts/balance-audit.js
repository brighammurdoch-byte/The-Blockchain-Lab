/**
 * Focused balance + directory audit
 * Usage: node scripts/balance-audit.js [baseUrl]
 */
const { chromium } = require('playwright');
const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function log(ok, name, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
  return ok;
}

(async () => {
  let failed = 0;
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const admin = await ctx.newPage();
  admin.on('console', (m) => { if (m.type() === 'error') console.log('[admin]', m.text()); });

  await admin.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await admin.click('#createSessionBtn');
  await admin.waitForURL(/admin/i, { timeout: 45000 });
  await wait(4000);
  let code = (await admin.locator('#sessionCode').textContent() || '').trim().toUpperCase();
  await admin.uncheck('#lockParameters').catch(() => {});
  await admin.locator('#difficultyLeading').fill('2');
  await admin.locator('#difficultySecondary').fill('15');
  await admin.locator('#miningReward').fill('10');
  await admin.click('#updateSettingsBtn');
  await wait(800);

  const miner = await ctx.newPage();
  miner.on('console', (m) => { if (m.type() === 'error') console.log('[miner]', m.text()); });
  await miner.goto(BASE, { waitUntil: 'domcontentloaded' });
  await miner.fill('#joinCode', code);
  await miner.selectOption('#roleSelect', 'participant');
  await miner.click('#joinForm button[type="submit"]');
  await miner.waitForURL(/participate/i, { timeout: 30000 });
  await wait(4000);
  await miner.fill('#nodeName', 'BalMiner');
  await miner.click('#setNodeNameBtn');
  await miner.click('#mineBtn');

  // Wait for miner balance > 20
  let minerBal = 0;
  for (let i = 0; i < 30; i++) {
    await wait(2000);
    minerBal = parseFloat(await miner.locator('#yourBalance').textContent()) || 0;
    if (minerBal >= 20) break;
  }
  if (!log(minerBal >= 20, 'Miner earned coins', String(minerBal))) failed++;

  const wallet = await ctx.newPage();
  wallet.on('console', (m) => { if (m.type() === 'error') console.log('[wallet]', m.text()); });
  await wallet.goto(BASE, { waitUntil: 'domcontentloaded' });
  await wallet.fill('#joinCode', code);
  await wallet.selectOption('#roleSelect', 'observer');
  await wallet.click('#joinForm button[type="submit"]');
  await wallet.waitForURL(/observe/i, { timeout: 30000 });
  await wait(5000);
  await wallet.fill('#nodeName', 'BalWallet');
  await wallet.click('#setNodeNameBtn');
  await wait(1500);

  const minerAddr = (await miner.locator('#yourAddress').textContent() || '').trim();
  const walletAddr = (await wallet.locator('#yourAddress').textContent() || '').trim();
  console.log('INFO  minerAddr=' + minerAddr + ' walletAddr=' + walletAddr);

  // Wait until miner directory lists wallet
  let listed = false;
  for (let i = 0; i < 15; i++) {
    const html = await miner.locator('#participantDirectory').innerHTML().catch(() => '');
    if (html && html.indexOf(walletAddr) !== -1) { listed = true; break; }
    await wait(1000);
  }
  if (!log(listed, 'Wallet appears in miner directory', listed ? 'ok' : 'missing')) failed++;

  await miner.bringToFront();
  await miner.fill('#recipientAddress', walletAddr);
  await miner.fill('#transactionAmount', '7');
  await miner.click('#transactionForm button[type="submit"]');
  console.log('INFO  sent 7 from miner to wallet');

  let walletBal = 0;
  let adminHas = false;
  for (let i = 0; i < 25; i++) {
    await wait(2000);
    walletBal = parseFloat(await wallet.locator('#yourBalance').textContent()) || 0;
    const adminText = await admin.locator('#participantsList').innerText();
    adminHas = adminText.indexOf(walletAddr) !== -1 && /BalWallet|7|1[0-9]/.test(adminText);
    const hub = await admin.evaluate(() => {
      const rs = window.relayState || (window.BlockchainLabCoordinator && window.BlockchainLabCoordinator.lab);
      if (!rs || !rs.participants) return null;
      const arr = Array.from(rs.participants.values());
      return arr.map((p) => ({ id: p.userId, bal: p.balance, name: p.displayName || p.name, role: p.role }));
    }).catch(() => null);
    console.log('INFO  t=' + ((i + 1) * 2) + 's walletUI=' + walletBal + ' hub=' + JSON.stringify(hub));
    if (walletBal >= 7) break;
  }

    if (!log(walletBal >= 7 && walletBal < 14, 'Wallet UI balance after receive (no double-credit)', String(walletBal))) failed++;

  const hubFinal = await admin.evaluate(() => {
    const rs = window.relayState || (window.BlockchainLabCoordinator && window.BlockchainLabCoordinator.lab);
    if (!rs) return null;
    // Prefer closure relayState via coordinator
    try {
      if (window.BlockchainLabCoordinator && window.BlockchainLabCoordinator.lab) {
        return Array.from(window.BlockchainLabCoordinator.lab.participants.values()).map((p) => ({ id: p.userId, bal: p.balance, name: p.displayName || p.name }));
      }
    } catch (e) {}
    return Array.from(rs.participants.values()).map((p) => ({ id: p.userId, bal: p.balance, name: p.displayName || p.name }));
  });
  const walletHub = (hubFinal || []).find((p) => p.id === walletAddr);
  if (!log(walletHub && walletHub.bal >= 7 && walletHub.bal < 14, 'Hub state wallet balance (no double-credit)', JSON.stringify(walletHub))) failed++;

  await miner.click('#stopMineBtn').catch(() => {});
  await browser.close();
  console.log('\n=== BALANCE AUDIT === ' + (failed ? failed + ' failed' : 'all passed'));
  process.exit(failed ? 1 : 0);
})();
