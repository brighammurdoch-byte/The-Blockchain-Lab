/**
 * Bitcoin classroom = same hub + miner/wallet flow as the main lab.
 * Usage: node scripts/bitcoin-classroom-audit.js [baseUrl]
 */
const { chromium } = require('playwright');
const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');

const results = [];
function pass(name, detail) { results.push({ ok: true, name, detail: detail || '' }); console.log('PASS  ' + name + (detail ? ' — ' + detail : '')); }
function fail(name, detail) { results.push({ ok: false, name, detail: detail || '' }); console.log('FAIL  ' + name + ' — ' + detail); }
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  try {
    const landing = await ctx.newPage();
    await landing.goto(BASE + '/bitcoin', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(800);
    const h1 = (await landing.locator('h1').textContent() || '').trim();
    if (/Bitcoin Lab/i.test(h1)) pass('Landing heading', h1);
    else fail('Landing heading', h1);
    if (await landing.locator('#createSessionBtn').count()) pass('Create session button', 'present');
    else fail('Create session button', 'missing');
    if (await landing.locator('#roleSelect option[value="participant"]').count() &&
        await landing.locator('#roleSelect option[value="observer"]').count()) {
      pass('Miner and wallet roles', 'both options');
    } else fail('Miner and wallet roles', 'missing');

    await landing.click('#createSessionBtn');
    await landing.waitForURL(/admin/i, { timeout: 45000 });
    await waitMs(2500);
    const adminUrl = landing.url();
    if (/chain=bitcoin/i.test(adminUrl)) pass('Admin URL carries chain=bitcoin', adminUrl);
    else fail('Admin URL carries chain=bitcoin', adminUrl);

    let code = ((await landing.locator('#sessionCode').textContent()) || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) {
      code = (new URL(adminUrl).searchParams.get('session') || '').toUpperCase();
    }
    if (code) pass('Session created', code);
    else fail('Session created', 'no code');

    const banner = await landing.locator('#chainFlavorBanner').innerText().catch(() => '');
    if (/Bitcoin classroom/i.test(banner)) pass('Admin Bitcoin banner', banner.slice(0, 80));
    else fail('Admin Bitcoin banner', banner);

    const reward = await landing.locator('#miningReward').inputValue().catch(() => '');
    if (reward === '50') pass('Default subsidy 50 BTC', reward);
    else fail('Default subsidy 50 BTC', reward);

    const share = await landing.locator('#joinShareLink').inputValue().catch(() => '');
    if (/\/bitcoin/i.test(share) && /join=/i.test(share)) pass('Share link is Bitcoin join', share);
    else fail('Share link is Bitcoin join', share);

    const miner = await ctx.newPage();
    await miner.goto(BASE + '/bitcoin?join=' + encodeURIComponent(code), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(500);
    await miner.selectOption('#roleSelect', 'participant');
    await miner.click('#joinForm button[type="submit"]');
    await miner.waitForURL(/participate/i, { timeout: 25000 });
    await waitMs(2500);
    if (/chain=bitcoin/i.test(miner.url())) pass('Miner URL carries chain=bitcoin', miner.url());
    else fail('Miner URL carries chain=bitcoin', miner.url());
    const minerBanner = await miner.locator('#chainFlavorBanner').innerText().catch(() => '');
    const unit = await miner.locator('.js-unit-label').first().textContent().catch(() => '');
    if (/BTC/i.test(unit) || /Bitcoin classroom/i.test(minerBanner)) {
      pass('Miner sees Bitcoin units', 'unit=' + unit);
    } else fail('Miner sees Bitcoin units', 'unit=' + unit + ' banner=' + minerBanner);

    await miner.click('#mineBtn');
    let bal = 0;
    for (let i = 0; i < 20; i++) {
      await waitMs(1000);
      bal = parseFloat(await miner.locator('#yourBalance').textContent()) || 0;
      if (bal >= 50) break;
    }
    if (bal >= 50) pass('Miner earns 50 BTC subsidy', 'balance=' + bal);
    else fail('Miner earns 50 BTC subsidy', 'balance=' + bal);
  } catch (e) {
    fail('Audit crashed', e && e.message ? e.message : String(e));
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + results.length + ' checks, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
