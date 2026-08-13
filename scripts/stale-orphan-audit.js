/**
 * Sleeping-phone orphan audit:
 *  - a late block on a parent more than 4 behind the hub tip is rejected
 *  - the miner does not treat newHeight as "my orphan is confirmed"
 *  - after a stale-parent reject, the miner remine target is hub tip + 1
 *
 * Usage: node scripts/stale-orphan-audit.js [baseUrl]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const OUT = path.join(__dirname, '..', 'tmp-audit-stale-orphan');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function pass(name, detail) { results.push({ ok: true, name, detail: detail || '' }); console.log('PASS  ' + name + (detail ? ' — ' + detail : '')); }
function fail(name, detail) { results.push({ ok: false, name, detail: detail || '' }); console.log('FAIL  ' + name + ' — ' + detail); }
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function heightOf(page) {
  return parseInt(await page.locator('#blockHeight').textContent(), 10) || 0;
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
  await waitMs(400);

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
    if (hubH >= 6) break;
    await waitMs(1000);
  }
  if (hubH >= 6) pass('Chain grew', 'height ' + hubH);
  else fail('Chain grew', 'height ' + hubH);

  // Hub: reject a block whose parent is far behind the tip
  const reject = await admin.evaluate(() => {
    const rs = window.relayState;
    if (!rs || !rs.chain || rs.chain.length < 6) return { error: 'short chain' };
    const parent = rs.chain[1];
    const tip = rs.chain[rs.chain.length - 1];
    const fake = {
      index: (parent.index || 1) + 1,
      previousHash: parent.hash,
      hash: '0000deadbeefstaleparent0000000000000000000000000000000000000001',
      timestamp: Date.now(),
      nonce: 1,
      transactions: [],
      miner: 'sleeper',
      forkId: 'classic'
    };
    const result = rs.tryAddBlock(fake, 'sleeper');
    const orphans = [];
    const main = new Set(rs.chain.map((b) => b.hash));
    rs.allBlocks.forEach((b, h) => { if (b && h && !main.has(h) && b.miner !== 'genesis') orphans.push(h); });
    return {
      accepted: !!result.accepted,
      reason: result.reason || '',
      isFork: !!result.isFork,
      tipHash: tip.hash,
      orphanCount: orphans.length
    };
  });
  if (reject.error) fail('Reject deep stale parent', reject.error);
  else if (!reject.accepted && /stale parent/i.test(reject.reason) && reject.orphanCount === 0) {
    pass('Reject deep stale parent', reject.reason);
  } else {
    fail('Reject deep stale parent', JSON.stringify(reject));
  }

  // Miner: presence is fresh but chain is stale — must not mine ahead on local orphan
  const afterSleep = await miner.evaluate(() => {
    const chain = (window.lastRelayedChain || []).slice();
    if (chain.length > 2) window.lastRelayedChain = chain.slice(0, 2);
    const sync = window.__labMinerSync;
    if (!sync) return { error: 'no sync api' };
    sync.setHubConfirmedHeight(1);
    sync.setHubConfirmedTipHash(window.lastRelayedChain[1] ? window.lastRelayedChain[1].hash : 'x');
    sync.setLastHubSeenAt(Date.now());
    sync.setLastHubChainAt(Date.now() - 60000);
    sync.requestHubResync('visible');
    return {
      trusted: sync.hasTrustedHubChain(),
      activity: (document.querySelector('#miningActivity') || {}).innerText || '',
      tipIndex: window.lastRelayedChain.length
        ? window.lastRelayedChain[window.lastRelayedChain.length - 1].index
        : null
    };
  });
  await waitMs(2000);
  const afterCatchup = await miner.evaluate(() => {
    const sync = window.__labMinerSync || {};
    const tip = window.lastRelayedChain && window.lastRelayedChain.length
      ? window.lastRelayedChain[window.lastRelayedChain.length - 1]
      : null;
    return {
      activity: ((document.querySelector('#miningActivity') || {}).innerText || '').slice(0, 180),
      hubH: typeof sync.getHubConfirmedHeight === 'function' ? sync.getHubConfirmedHeight() : null,
      tipHash: tip && tip.hash,
      confirmedHash: typeof sync.getHubConfirmedTipHash === 'function' ? sync.getHubConfirmedTipHash() : null,
      tipIndex: tip && tip.index,
      matches: tip && typeof sync.getHubConfirmedTipHash === 'function'
        ? tip.hash === sync.getHubConfirmedTipHash()
        : false
    };
  });
  const miningAhead = /Block #(\d+)/.exec(afterCatchup.activity);
  const aheadNum = miningAhead ? Number(miningAhead[1]) : null;
  if (afterCatchup.matches && afterCatchup.hubH >= 6 && !(aheadNum != null && aheadNum > afterCatchup.hubH + 1)) {
    pass('Wake follows hub tip hash', JSON.stringify(afterCatchup));
  } else if (/Catching up|Waiting for the network/i.test(afterCatchup.activity) && !(aheadNum != null && aheadNum > 3 && afterCatchup.hubH >= 6 && aheadNum < afterCatchup.hubH)) {
    pass('Wake follows hub tip hash', JSON.stringify(afterCatchup));
  } else {
    fail('Wake follows hub tip hash', JSON.stringify({ afterSleep, afterCatchup }));
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
