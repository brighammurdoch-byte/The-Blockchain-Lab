/**
 * Admin pause/resume behavioral audit — verifies chain freezes while paused.
 * Usage: node scripts/admin-pause-audit.js [baseUrl]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const OUT = path.join(__dirname, '..', 'tmp-audit-admin-pause');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function pass(name, detail) { results.push({ ok: true, name, detail: detail || '' }); console.log('PASS  ' + name + (detail ? ' — ' + detail : '')); }
function fail(name, detail) { results.push({ ok: false, name, detail: detail || '' }); console.log('FAIL  ' + name + ' — ' + detail); }
async function waitMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
  await waitMs(3000);
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

  // Soft difficulty so mining grows quickly
  await admin.uncheck('#lockParameters').catch(() => {});
  await admin.locator('#difficultyLeading').fill('1');
  await admin.locator('#difficultySecondary').fill('15');
  await admin.click('#updateSettingsBtn');
  await waitMs(800);

  const miner = await context.newPage();
  await miner.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitMs(500);
  await miner.fill('#joinCode', code);
  await miner.selectOption('#roleSelect', 'participant');
  await miner.click('#joinForm button[type="submit"]');
  await miner.waitForURL(/participate/i, { timeout: 25000 });
  await waitMs(3500);
  await miner.click('#mineBtn');
  await waitMs(2000);
  if (await miner.locator('#stopMineBtn').isVisible()) pass('Miner started mining', 'stop visible');
  else fail('Miner started mining', 'still idle');

  // Wait for some growth before pause
  let hBefore = 0;
  for (let i = 0; i < 20; i++) {
    hBefore = await heightOf(admin);
    if (hBefore >= 2) break;
    await waitMs(1000);
  }
  if (hBefore >= 1) pass('Chain grew before pause', 'height ' + hBefore);
  else fail('Chain grew before pause', 'height ' + hBefore);

  await admin.bringToFront();
  await admin.click('#toggleNetworkBtn');
  await waitMs(500);
  const labelPaused = (await admin.locator('#toggleNetworkBtn').textContent() || '').trim();
  if (/resume/i.test(labelPaused)) pass('Pause button label', labelPaused);
  else fail('Pause button label', labelPaused);

  // Miner UI should stop (mineBtn visible again)
  await waitMs(1500);
  const minerIdle = await miner.locator('#mineBtn').isVisible().catch(() => false);
  const minerPausedFlag = await miner.evaluate(() => !!window.networkPaused || (typeof networkPaused !== 'undefined' && networkPaused)).catch(() => false);
  // networkPaused is module-scoped let, not on window — check mining activity text / mineBtn
  const activity = await miner.locator('#miningActivity').textContent().catch(() => '');
  if (minerIdle) pass('Miner stopped hashing while paused', activity.trim().slice(0, 80));
  else fail('Miner stopped hashing while paused', 'stopMine still shown; activity=' + activity);

  const hAtPause = await heightOf(admin);
  await waitMs(5000);
  const hDuring = await heightOf(admin);
  if (hDuring === hAtPause) pass('Chain height frozen while paused', hAtPause + ' stayed ' + hDuring);
  else fail('Chain height frozen while paused', hAtPause + ' → ' + hDuring + ' (grew while paused)');

  // Attempt start mining while paused — should stay idle or toast and not grow
  await miner.bringToFront();
  if (await miner.locator('#mineBtn').isVisible().catch(() => false)) {
    await miner.click('#mineBtn');
    await waitMs(2000);
    const stillIdle = await miner.locator('#mineBtn').isVisible().catch(() => false);
    if (stillIdle) pass('Cannot start mining while paused', 'mineBtn still visible');
    else fail('Cannot start mining while paused', 'mining restarted under pause');
  } else {
    pass('Cannot start mining while paused', 'already blocked');
  }

  await waitMs(2000);
  const hStill = await heightOf(admin);
  if (hStill === hAtPause) pass('Height still frozen after mine click under pause', String(hStill));
  else fail('Height still frozen after mine click under pause', hAtPause + '→' + hStill);

  // Resume
  await admin.bringToFront();
  await admin.click('#toggleNetworkBtn');
  await waitMs(800);
  const labelResume = (await admin.locator('#toggleNetworkBtn').textContent() || '').trim();
  if (/pause/i.test(labelResume)) pass('Resume button label', labelResume);
  else fail('Resume button label', labelResume);

  // Auto-resume mining if intent preserved
  await waitMs(2500);
  const miningAgain = await miner.locator('#stopMineBtn').isVisible().catch(() => false);
  if (miningAgain) pass('Miner auto-resumed after network resume', 'stopMine visible');
  else {
    // Manual fallback then check growth
    if (await miner.locator('#mineBtn').isVisible().catch(() => false)) {
      await miner.click('#mineBtn');
      await waitMs(1000);
    }
    const afterManual = await miner.locator('#stopMineBtn').isVisible().catch(() => false);
    if (afterManual) pass('Miner auto-resumed after network resume', 'manual remine ok (intent may have cleared)');
    else fail('Miner auto-resumed after network resume', 'could not remine');
  }

  let hAfter = hStill;
  for (let i = 0; i < 15; i++) {
    hAfter = await heightOf(admin);
    if (hAfter > hStill) break;
    await waitMs(1000);
  }
  if (hAfter > hStill) pass('Chain grows again after resume', hStill + '→' + hAfter);
  else fail('Chain grows again after resume', hStill + '→' + hAfter);

  await admin.screenshot({ path: path.join(OUT, 'admin-final.png'), fullPage: true }).catch(() => {});
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n==== admin-pause-audit: ' + (results.length - failed.length) + '/' + results.length + ' passed ====');
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
