/**
 * Phone sleep / refresh remine: must catch up to the hub tip, never stay
 * on a stale height or fall back to mining block #1.
 *
 * Usage: node scripts/mobile-resync-audit.js [baseUrl]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const OUT = path.join(__dirname, '..', 'tmp-audit-mobile-resync');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function pass(name, detail) { results.push({ ok: true, name, detail: detail || '' }); console.log('PASS  ' + name + (detail ? ' — ' + detail : '')); }
function fail(name, detail) { results.push({ ok: false, name, detail: detail || '' }); console.log('FAIL  ' + name + ' — ' + detail); }
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function heightOf(page) {
  return parseInt(await page.locator('#blockHeight').textContent(), 10) || 0;
}

async function miningLabel(page) {
  return (await page.locator('#miningActivity').innerText().catch(() => '')) || '';
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const admin = await context.newPage();
  await admin.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitMs(800);
  await admin.click('#createSessionBtn');
  await admin.waitForURL(/admin/i, { timeout: 45000 });
  await waitMs(2500);
  let code = (await admin.locator('#sessionCode').textContent().catch(() => '') || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) {
    code = (new URL(admin.url()).searchParams.get('session') || '').toUpperCase();
  }
  if (!code) {
    fail('Create session', 'no code');
    await browser.close();
    process.exit(1);
  }
  pass('Create session', code);

  await admin.uncheck('#lockParameters').catch(() => {});
  await admin.uncheck('#autoDifficulty').catch(() => {});
  await admin.locator('#difficultyLeading').fill('1');
  await admin.locator('#difficultySecondary').fill('15');
  await admin.click('#updateSettingsBtn');
  await waitMs(500);

  const miner = await context.newPage();
  await miner.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitMs(400);
  await miner.fill('#joinCode', code);
  await miner.selectOption('#roleSelect', 'participant');
  await miner.click('#joinForm button[type="submit"]');
  await miner.waitForURL(/participate/i, { timeout: 25000 });
  await waitMs(2500);
  await miner.click('#mineBtn');

  let hubH = 0;
  for (let i = 0; i < 25; i++) {
    hubH = await heightOf(admin);
    if (hubH >= 4) break;
    await waitMs(1000);
  }
  if (hubH >= 3) pass('Chain grew before sleep sim', 'height ' + hubH);
  else fail('Chain grew before sleep sim', 'height ' + hubH);

  // --- Compact snapshot for a long classroom chain ---
  const compact = await admin.evaluate(() => {
    const rs = window.relayState;
    if (!rs || !rs.chain) return { error: 'no relayState' };
    const start = rs.chain.length;
    for (let i = start; i < 80; i++) {
      const prev = rs.chain[rs.chain.length - 1];
      const b = {
        index: i,
        hash: 'pad-' + i,
        previousHash: prev.hash,
        timestamp: Date.now(),
        nonce: 0,
        transactions: Array.from({ length: 12 }, (_, k) => ({
          id: 'tx-' + i + '-' + k,
          from: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          to: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          amount: 1,
          timestamp: Date.now()
        })),
        miner: 'pad',
        forkId: 'classic'
      };
      rs.chain.push(b);
      if (rs.allBlocks && typeof rs.allBlocks.set === 'function') rs.allBlocks.set(b.hash, b);
    }
    rs.networkStats.blockHeight = rs.chain.length - 1;
    const snap = rs.getSanitizedStateForNewPeer();
    let size = 0;
    try { size = JSON.stringify(snap).length; } catch (e) { size = -1; }
    return {
      chainLen: snap.chain ? snap.chain.length : 0,
      truncated: !!snap.chainTruncated,
      height: snap.chainHeight,
      size: size
    };
  });
  if (compact.error) fail('Compact snapshot', compact.error);
  else if (compact.size > 0 && compact.size < 90000 && compact.height >= 70) {
    pass('Compact snapshot fits MQTT', JSON.stringify(compact));
  } else {
    fail('Compact snapshot fits MQTT', JSON.stringify(compact));
  }

  // --- Sleep/wake: miner is stuck on an old height ---
  await miner.evaluate(() => {
    const chain = (window.lastRelayedChain || []).slice();
    if (chain.length > 2) window.lastRelayedChain = chain.slice(0, 2);
    if (window.__labMinerSync) {
      window.__labMinerSync.setHubConfirmedHeight(1);
      window.__labMinerSync.setLastHubSeenAt(Date.now() - 60000);
    }
  });
  await miner.evaluate(() => {
    if (window.BlockchainLabNet && typeof window.BlockchainLabNet._emit === 'function') {
      window.BlockchainLabNet._emit('transport-reconnected', {});
    }
  });
  await waitMs(2500);

  const afterWake = await miner.evaluate(() => {
    const act = (document.querySelector('#miningActivity') || {}).innerText || '';
    const sync = window.__labMinerSync || {};
    return {
      activity: act,
      hubH: typeof sync.getHubConfirmedHeight === 'function' ? sync.getHubConfirmedHeight() : null,
      trusted: typeof sync.hasTrustedHubChain === 'function' ? sync.hasTrustedHubChain() : null,
      chainLen: (window.lastRelayedChain || []).length,
      tipIndex: window.lastRelayedChain && window.lastRelayedChain.length
        ? window.lastRelayedChain[window.lastRelayedChain.length - 1].index
        : null
    };
  });
  const wakeStuckOnOld = /Block #2\b/.test(afterWake.activity) && afterWake.hubH != null && afterWake.hubH > 3;
  if (!wakeStuckOnOld && (afterWake.hubH >= hubH || /Catching up|Waiting for the network/i.test(afterWake.activity) || (afterWake.tipIndex != null && afterWake.tipIndex >= hubH))) {
    pass('Wake resyncs off stale height', JSON.stringify(afterWake));
  } else {
    fail('Wake resyncs off stale height', JSON.stringify(afterWake));
  }

  // --- Refresh: empty local chain must not mine block 1 ---
  await miner.evaluate(() => {
    window.lastRelayedChain = [];
    if (window.__labMinerSync) {
      window.__labMinerSync.setHubConfirmedHeight(0);
      window.__labMinerSync.setLastHubSeenAt(0);
    }
    if (typeof window.startMining === 'function') {
      // startMining is not global; click path already mining
    }
    if (window.__labMinerSync) window.__labMinerSync.requestHubResync('no-chain');
  });
  await waitMs(400);
  const afterRefresh = await miningLabel(miner);
  if (/Block #1\b/.test(afterRefresh) && !/Catching up/i.test(afterRefresh)) {
    fail('Refresh does not mine block 1', afterRefresh.slice(0, 180));
  } else {
    pass('Refresh does not mine block 1', afterRefresh.slice(0, 180));
  }

  await waitMs(2500);
  const afterCatchup = await miner.evaluate(() => {
    const act = (document.querySelector('#miningActivity') || {}).innerText || '';
    const sync = window.__labMinerSync || {};
    const tip = window.lastRelayedChain && window.lastRelayedChain.length
      ? window.lastRelayedChain[window.lastRelayedChain.length - 1]
      : null;
    return {
      activity: act.slice(0, 200),
      hubH: typeof sync.getHubConfirmedHeight === 'function' ? sync.getHubConfirmedHeight() : null,
      tipIndex: tip && tip.index,
      chainLen: (window.lastRelayedChain || []).length
    };
  });
  const miningOne = /Block #1\b/.test(afterCatchup.activity);
  if (!miningOne && afterCatchup.hubH != null && afterCatchup.hubH >= 3) {
    pass('Refresh catch-up uses hub tip', JSON.stringify(afterCatchup));
  } else if (!miningOne && /Catching up/i.test(afterCatchup.activity)) {
    pass('Refresh catch-up uses hub tip', 'still catching up: ' + JSON.stringify(afterCatchup));
  } else {
    fail('Refresh catch-up uses hub tip', JSON.stringify(afterCatchup));
  }

  await miner.screenshot({ path: path.join(OUT, 'miner.png'), fullPage: true }).catch(() => {});
  await admin.screenshot({ path: path.join(OUT, 'admin.png'), fullPage: true }).catch(() => {});
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + results.length + ' checks, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
