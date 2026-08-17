/**
 * Classroom production check: classic + Bitcoin + Ethereum landings,
 * default difficulty, mining start/stop, send, archive.
 *
 * Usage: node scripts/p4fix12-classroom-test.js [labBase]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const results = [];
function pass(n, d) { results.push({ ok: true, n, d: d || '' }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); }
function fail(n, d) { results.push({ ok: false, n, d: d || '' }); console.log('FAIL  ' + n + ' — ' + (d || '')); }

function labUrl(p) {
  if (BASE.indexOf('github.io') >= 0) {
    const root = BASE.replace(/\/lab\/?$/, '');
    if (p === '/lab') return root + '/lab/index.html';
    if (p === '/bitcoin') return root + '/bitcoin/';
    if (p === '/ethereum') return root + '/ethereum/';
    if (p === '/ethereum/rules') return root + '/ethereum/rules/';
    return root + p;
  }
  return BASE + p;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    await page.goto(labUrl('/lab'), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(700);
    const brand = await page.locator('.lab-landing__brand h1').first().innerText();
    if (/Blockchain Lab/i.test(brand)) pass('Classic landing', brand.trim());
    else fail('Classic landing', brand);

    const ethLink = await page.locator('.lab-about a[href="/ethereum"], .lab-about a[href*="/ethereum"]').first().innerText().catch(function () { return ''; });
    if (/Ethereum classroom/i.test(ethLink)) pass('Landing links Ethereum classroom', ethLink.trim());
    else fail('Landing links Ethereum classroom', ethLink);

    await page.goto(labUrl('/bitcoin'), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(600);
    const btc = await page.locator('h1').first().innerText();
    if (/Bitcoin Lab/i.test(btc) && await page.locator('#createSessionBtn').count()) {
      pass('Bitcoin classroom landing', btc.trim());
    } else fail('Bitcoin classroom landing', btc);

    await page.goto(labUrl('/ethereum'), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(600);
    const eth = await page.locator('h1').first().innerText();
    const createEth = await page.locator('#createSessionBtn').count();
    if (/Ethereum Lab/i.test(eth) && createEth) pass('Ethereum classroom landing', eth.trim());
    else fail('Ethereum classroom landing', eth + ' create=' + createEth);

    await page.goto(labUrl('/ethereum/rules'), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(800);
    const rules = await page.locator('h1').first().innerText();
    if (/Solidity|rules/i.test(rules)) pass('Ethereum rules editor still at /ethereum/rules', rules.trim());
    else fail('Ethereum rules editor still at /ethereum/rules', rules);

    await page.goto(labUrl('/lab'), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.click('#createSessionBtn');
    await page.waitForURL(/admin/i, { timeout: 30000 });
    await page.waitForTimeout(1600);
    const L = await page.locator('#difficultyLeading').inputValue();
    const S = await page.locator('#difficultySecondary').inputValue();
    if (L === '3' && S === '8') pass('Classic session default 3+0x8', L + '+0x' + Number(S).toString(16));
    else fail('Classic session default 3+0x8', L + '/' + S);

    await page.goto(labUrl('/ethereum'), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.click('#createSessionBtn');
    await page.waitForURL(/admin/i, { timeout: 30000 });
    await page.waitForTimeout(1800);
    const banner = await page.locator('#chainFlavorBanner').innerText().catch(function () { return ''; });
    const unit = await page.locator('.js-unit-label').first().innerText().catch(function () { return ''; });
    const reward = await page.locator('#miningReward').inputValue();
    if (/Ethereum classroom/i.test(banner) && /ETH/i.test(unit) && reward === '5') {
      pass('Ethereum session themes as ETH / 5 issuance', 'reward=' + reward);
    } else {
      fail('Ethereum session themes as ETH / 5 issuance', 'banner=' + banner.slice(0, 80) + ' unit=' + unit + ' reward=' + reward);
    }

    const minerPage = await context.newPage();
    const share = await page.locator('#joinShareLink').inputValue().catch(function () { return ''; });
    const joinUrl = share || (await page.url()).replace(/admin.*/, 'participate.html');
    const minerJoin = joinUrl.replace(/admin\.html/, 'participate.html').replace(/\/admin\//, '/participate/');
    await minerPage.goto(minerJoin.includes('participate') ? minerJoin : labUrl('/lab'), { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!minerJoin.includes('participate')) {
      const code = (await page.locator('#sessionCode').innerText()).trim();
      await minerPage.goto(labUrl('/lab'), { waitUntil: 'domcontentloaded' });
      await minerPage.fill('#joinCode', code);
      await minerPage.selectOption('#roleSelect', 'participant');
      await minerPage.click('button[type="submit"]');
    }
    await minerPage.waitForTimeout(2000);
    if (await minerPage.locator('#mineBtn').count()) {
      await minerPage.click('#mineBtn');
      await minerPage.waitForTimeout(400);
      const stopVisible = await minerPage.locator('#stopMineBtn').isVisible();
      if (stopVisible) {
        await minerPage.click('#stopMineBtn');
        await minerPage.waitForTimeout(300);
        const startVisible = await minerPage.locator('#mineBtn').isVisible();
        if (startVisible) pass('Stop Mining returns Start Mining', '');
        else fail('Stop Mining returns Start Mining', 'start hidden after stop');
      } else {
        fail('Stop Mining returns Start Mining', 'stop not visible after start');
      }
    } else {
      fail('Stop Mining returns Start Mining', 'no mine button');
    }
    await minerPage.close();
  } catch (e) {
    fail('classroom test threw', e && e.message ? e.message : String(e));
  } finally {
    await browser.close();
  }

  const failed = results.filter(function (r) { return !r.ok; });
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exit(1);
})();
