/**
 * Mobile hub-toast regression: settings rebroadcasts must not pop
 * "Switched to Admin-hosted hub" unless the instructor actually
 * changed network mode.
 *
 * Usage: node scripts/hub-toast-audit.js [baseUrl]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const OUT = path.join(__dirname, '..', 'tmp-audit-hub-toast');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function pass(name, detail) { results.push({ ok: true, name, detail: detail || '' }); console.log('PASS  ' + name + (detail ? ' — ' + detail : '')); }
function fail(name, detail) { results.push({ ok: false, name, detail: detail || '' }); console.log('FAIL  ' + name + ' — ' + detail); }
async function waitMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function hookToasts(page) {
  await page.evaluate(() => {
    window.__toastLog = [];
    const push = (text) => {
      const t = String(text || '').trim();
      if (!t) return;
      const last = window.__toastLog[window.__toastLog.length - 1];
      if (last === t) return;
      window.__toastLog.push(t);
    };
    const el = document.getElementById('toastNotification');
    if (el) push(el.textContent);
    const mo = new MutationObserver(() => {
      const n = document.getElementById('toastNotification');
      if (n) push(n.textContent);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  });
}

async function toastLog(page) {
  return page.evaluate(() => (window.__toastLog || []).slice());
}

function countHubToasts(log) {
  return log.filter((t) => /admin-hosted hub/i.test(t)).length;
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
  if (await admin.locator('#networkModeSelect').count()) {
    await admin.selectOption('#networkModeSelect', 'admin-relay');
  }
  await admin.click('#updateSettingsBtn');
  await waitMs(600);

  const miner = await context.newPage();
  await miner.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitMs(500);
  await miner.fill('#joinCode', code);
  await miner.selectOption('#roleSelect', 'participant');
  await miner.click('#joinForm button[type="submit"]');
  await miner.waitForURL(/participate/i, { timeout: 25000 });
  await waitMs(2500);
  await hookToasts(miner);
  await waitMs(1500);

  const before = await toastLog(miner);
  const hubBefore = countHubToasts(before);

  // Same-mode settings broadcasts (retarget / Update Settings spam)
  for (let i = 0; i < 4; i++) {
    await admin.click('#updateSettingsBtn');
    await waitMs(400);
  }

  // Direct retarget-shaped payload (what maybeRetargetDifficulty sends)
  await miner.evaluate(() => {
    const net = window.BlockchainLabNet;
    if (!net || typeof net._emit !== 'function') return;
    for (let i = 0; i < 3; i++) {
      net._emit('admin-settings-updated', {
        type: 'admin-settings-updated',
        payload: {
          networkMode: 'admin-relay',
          difficultyLeading: 2 + i,
          difficultySecondary: 8,
          miningRewardCoins: 10,
          autoDifficulty: true,
          parametersLocked: false
        },
        timestamp: Date.now() + i
      });
    }
  });
  await waitMs(800);

  const afterSpam = await toastLog(miner);
  const hubAfterSpam = countHubToasts(afterSpam);
  if (hubAfterSpam === hubBefore) {
    pass('Same-mode settings do not toast hub', 'hub toasts still ' + hubAfterSpam);
  } else {
    fail('Same-mode settings do not toast hub', 'before=' + hubBefore + ' after=' + hubAfterSpam + ' log=' + JSON.stringify(afterSpam));
  }

  // Real mode switch should still toast once
  if (await admin.locator('#networkModeSelect').count()) {
    await admin.selectOption('#networkModeSelect', 'p2p');
    await admin.click('#updateSettingsBtn');
    await waitMs(800);
    const afterP2p = await toastLog(miner);
    const p2pToasts = afterP2p.filter((t) => /full p2p mesh/i.test(t)).length;
    if (p2pToasts >= 1) pass('Real switch to P2P toasts', 'count ' + p2pToasts);
    else fail('Real switch to P2P toasts', JSON.stringify(afterP2p));

    await admin.selectOption('#networkModeSelect', 'admin-relay');
    await admin.click('#updateSettingsBtn');
    await waitMs(800);
    const afterBack = await toastLog(miner);
    const hubAfterBack = countHubToasts(afterBack);
    if (hubAfterBack === hubBefore + 1) {
      pass('Real switch back to hub toasts once', 'count ' + hubAfterBack);
    } else {
      fail('Real switch back to hub toasts once', 'expected ' + (hubBefore + 1) + ' got ' + hubAfterBack + ' log=' + JSON.stringify(afterBack));
    }
  } else {
    fail('Mode select present', 'no #networkModeSelect');
  }

  await miner.screenshot({ path: path.join(OUT, 'miner.png'), fullPage: true }).catch(() => {});
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + results.length + ' checks, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
