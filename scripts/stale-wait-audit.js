/**
 * Phone slept while "waiting to confirm #N" — hub heartbeat with a later tip
 * must abandon that wait and catch up.
 * Usage: node scripts/stale-wait-audit.js [baseUrl]
 */
const { chromium } = require('playwright');
const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const results = [];
  const pass = (n, d) => { results.push({ ok: true, n }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); };
  const fail = (n, d) => { results.push({ ok: false, n }); console.log('FAIL  ' + n + ' — ' + d); };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await admin.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitMs(600);
  await admin.click('#createSessionBtn');
  await admin.waitForURL(/admin/i, { timeout: 45000 });
  await waitMs(2200);
  const code = ((await admin.locator('#sessionCode').textContent()) || '').trim().toUpperCase();
  pass('Session', code);

  const miner = await ctx.newPage();
  await miner.goto(BASE, { waitUntil: 'domcontentloaded' });
  await miner.fill('#joinCode', code);
  await miner.selectOption('#roleSelect', 'participant');
  await miner.click('#joinForm button[type="submit"]');
  await miner.waitForURL(/participate/i, { timeout: 25000 });
  await waitMs(2500);
  await miner.click('#mineBtn');
  await waitMs(800);

  await miner.evaluate(() => {
    const sync = window.__labMinerSync;
    window.lastRelayedChain = (window.lastRelayedChain || []).slice(0, 2);
    if (sync) {
      sync.setHubConfirmedHeight(36);
      sync.setHubConfirmedTipHash(
        window.lastRelayedChain[1] ? window.lastRelayedChain[1].hash : 'old-tip'
      );
      sync.setLastHubChainAt(Date.now() - 120000);
    }
    // Pretend we are waiting on #37 after a sleep
    if (typeof window.showWaitingForHub === 'function') {
      // not global
    }
    const act = document.getElementById('miningActivity');
    if (act) {
      act.innerHTML = '<div class="alert alert-warning"><p><strong>Waiting for the network to confirm block #37…</strong></p></div>';
    }
    if (sync && sync.noteHubTipHint) {
      sync.noteHubTipHint('hub-tip-80', 80);
    } else if (window.BlockchainLabNet) {
      window.BlockchainLabNet._emit('admin-presence', {
        payload: { tipHash: 'hub-tip-80', tipIndex: 80, chainHeight: 80 }
      });
    }
  });
  await waitMs(600);

  const after = await miner.evaluate(() => {
    const act = ((document.querySelector('#miningActivity') || {}).innerText || '');
    const sync = window.__labMinerSync || {};
    return {
      activity: act.slice(0, 160),
      hubH: typeof sync.getHubConfirmedHeight === 'function' ? sync.getHubConfirmedHeight() : null,
      waiting37: /confirm block #37/i.test(act)
    };
  });

  if (!after.waiting37 && after.hubH >= 80) pass('Presence tip abandons wait #37', JSON.stringify(after));
  else fail('Presence tip abandons wait #37', JSON.stringify(after));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + results.length + ' checks, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
