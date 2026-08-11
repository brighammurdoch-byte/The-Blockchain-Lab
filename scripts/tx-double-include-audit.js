/**
 * One transfer must appear in at most one block on the hub chain.
 * Usage: node scripts/tx-double-include-audit.js [baseUrl]
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
  await wait(400);

  async function join(role, name) {
    const p = await ctx.newPage();
    await p.goto(BASE, { waitUntil: 'domcontentloaded' });
    await p.fill('#joinCode', code);
    await p.selectOption('#roleSelect', role);
    await p.click('#joinForm button[type="submit"]');
    await p.waitForURL(role === 'observer' ? /observe/i : /participate/i, { timeout: 30000 });
    await wait(2500);
    await p.fill('#nodeName', name);
    await p.click('#setNodeNameBtn');
    return p;
  }

  const miner1 = await join('participant', 'M1');
  const miner2 = await join('participant', 'M2');
  const wallet = await join('observer', 'W1');

  let m1 = '', w1 = '';
  for (let i = 0; i < 20; i++) {
    m1 = (await miner1.locator('#yourAddress').textContent() || '').trim();
    w1 = (await wallet.locator('#yourAddress').textContent() || '').trim();
    const bal = parseFloat(await miner1.locator('#yourBalance').textContent()) || 0;
    if (m1 && w1 && bal >= 10) break;
    if (i === 5) {
      await miner1.click('#mineBtn');
    }
    await wait(1000);
  }
  // Ensure both mine hard to race the same mempool
  await miner1.click('#mineBtn').catch(() => {});
  await miner2.click('#mineBtn').catch(() => {});
  await wait(2000);

  // Mine a bit so miner has coins
  for (let i = 0; i < 15; i++) {
    const bal = parseFloat(await miner1.locator('#yourBalance').textContent()) || 0;
    if (bal >= 10) break;
    await wait(1000);
  }

  await miner1.fill('#recipientAddress', w1);
  await miner1.fill('#transactionAmount', '3');
  await miner1.click('#sendTransactionBtn, #transactionForm button[type="submit"]').catch(async () => {
    await miner1.evaluate(() => {
      const f = document.getElementById('transactionForm');
      if (f) f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  });

  // Let the race run
  await wait(12000);

  const chainInfo = await admin.evaluate(() => {
    const rs = window.relayState || null;
    // admin.js keeps relayState in module scope — fall back to scanning blockchainView
    if (rs && Array.isArray(rs.chain)) {
      const txs = [];
      rs.chain.forEach((b, idx) => {
        (b.transactions || []).forEach((t) => {
          txs.push({
            block: b.index != null ? b.index : idx,
            id: t.id || (t.from + ':' + t.to + ':' + t.timestamp),
            from: t.from,
            to: t.to,
            amount: t.amount
          });
        });
      });
      return { source: 'relayState', height: rs.chain.length - 1, txs };
    }
    return { source: 'none', height: 0, txs: [] };
  });

  // If relayState not on window, expose via page script binding
  let txs = chainInfo.txs || [];
  if (!txs.length) {
    // inject: admin page may not expose relayState; parse from DOM is weak.
    // Use evaluate on a patched path — re-read from global if we set it.
    const exposed = await admin.evaluate(() => {
      // Search common globals
      const candidates = [window.relayState, window.__relayState, window.labRelayState];
      for (const rs of candidates) {
        if (rs && Array.isArray(rs.chain)) return rs.chain;
      }
      return null;
    });
    if (exposed) {
      txs = [];
      exposed.forEach((b, idx) => {
        (b.transactions || []).forEach((t) => {
          txs.push({
            block: b.index != null ? b.index : idx,
            id: t.id || (t.from + ':' + t.to + ':' + t.timestamp),
            from: t.from, to: t.to, amount: t.amount
          });
        });
      });
    }
  }

  // Prefer matching our transfer amount 3 to wallet
  const matches = txs.filter((t) => String(t.to) === w1 && Number(t.amount) === 3);
  const byId = {};
  matches.forEach((t) => {
    byId[t.id] = (byId[t.id] || 0) + 1;
  });
  const maxDup = Object.keys(byId).reduce((m, k) => Math.max(m, byId[k]), 0);

  if (matches.length === 0) {
    // Fallback: any amount 3 transfer appears at most once
    const any3 = txs.filter((t) => Number(t.amount) === 3);
    const byId2 = {};
    any3.forEach((t) => { byId2[t.id] = (byId2[t.id] || 0) + 1; });
    const max2 = Object.keys(byId2).reduce((m, k) => Math.max(m, byId2[k]), 0);
    if (any3.length >= 1 && max2 <= 1) pass('No double-included transfer', 'count=' + any3.length);
    else if (any3.length === 0) fail('Transfer included at least once', 'no amount=3 txs found; total txs=' + txs.length);
    else fail('No double-included transfer', 'id counts ' + JSON.stringify(byId2));
  } else if (maxDup <= 1) {
    pass('No double-included transfer', 'occurrences=' + matches.length + ' unique');
  } else {
    fail('No double-included transfer', 'same tx in ' + maxDup + ' blocks: ' + JSON.stringify(byId));
  }

  const wb = parseFloat(await wallet.locator('#yourBalance').textContent()) || 0;
  // Endowment 0 + one 3-coin receive (double include would show 6 if both credited — balances dedupe)
  if (wb >= 3 && wb < 6) pass('Wallet balance reflects single credit', String(wb));
  else if (wb >= 6) fail('Wallet balance reflects single credit', 'got ' + wb + ' (possible double credit)');
  else fail('Wallet balance reflects single credit', String(wb));

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n==== tx-double-include-audit: ' + (results.length - failed) + '/' + results.length + ' passed ====');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
