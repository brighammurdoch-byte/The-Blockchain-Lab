/**
 * Smoke-test The Blockchain Lab like a classroom user (Playwright).
 * Usage: node scripts/smoke-user-test.js [baseUrl]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE =
  process.argv[2] ||
  'https://brighammurdoch-byte.github.io/The-Blockchain-Lab/lab/index.html';

const OUT = path.join(__dirname, '..', 'tmp-smoke');
fs.mkdirSync(OUT, { recursive: true });

function log(step, detail) {
  console.log(`[${step}] ${detail}`);
}

async function shot(page, name) {
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file, fullPage: true });
  log('shot', file);
}

(async () => {
  const results = [];
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-web-security'
    ]
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true
  });

  const admin = await context.newPage();
  admin.on('console', (m) => {
    if (m.type() === 'error') console.log('[admin console error]', m.text());
  });

  try {
    log('1', 'Open landing: ' + BASE);
    await admin.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await admin.waitForTimeout(1500);
    await shot(admin, '01-landing');

    const brand = await admin.locator('.lab-landing__brand h1').first().textContent();
    results.push({ test: 'Landing brand visible', ok: /Blockchain Lab/i.test(brand || ''), detail: brand });

    log('2', 'Create session (instructor)');
    await admin.click('#createSessionBtn');
    await admin.waitForURL(/admin/i, { timeout: 30000 });
    await admin.waitForTimeout(2500);
    await shot(admin, '02-admin');

    const sessionCode = (
      (await admin.locator('#sessionCode').textContent().catch(() => '')) ||
      (await admin.locator('#joinCodeDisplay').textContent().catch(() => '')) ||
      ''
    ).trim().toUpperCase();

    // Fallback: parse from URL
    let code = sessionCode;
    if (!code || code.length < 4) {
      const u = new URL(admin.url());
      code = (u.searchParams.get('session') || u.pathname.split('/').pop() || '').toUpperCase();
    }
    results.push({ test: 'Session created with code', ok: /^[A-Z0-9]{4,8}$/.test(code), detail: code || admin.url() });
    log('2', 'Session code=' + code);

    const share = await admin.locator('#joinShareLink').inputValue().catch(() => '');
    results.push({ test: 'Share link populated', ok: !!share && share.includes(code), detail: share });

    // QR canvas: not all white / has non-empty pixels
    const qrOk = await admin.evaluate(() => {
      const c = document.getElementById('joinQrCanvas');
      if (!c) return { ok: false, reason: 'no canvas' };
      const ctx = c.getContext('2d');
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) dark++;
      }
      return { ok: dark > 50, dark, w: c.width, h: c.height };
    });
    results.push({ test: 'QR code drawn', ok: !!qrOk.ok, detail: JSON.stringify(qrOk) });
    log('2', 'QR ' + JSON.stringify(qrOk));

    // Topology SVG nodes (may only be admin at first)
    await admin.waitForTimeout(1000);
    const topoBefore = await admin.evaluate(() => {
      const svg = document.querySelector('#networkVisualizationSvg');
      if (!svg) return { ok: false, reason: 'no svg' };
      const circles = svg.querySelectorAll('circle, .node-circle');
      const nodes = svg.querySelectorAll('g.node');
      return { ok: nodes.length > 0 || circles.length > 0, nodes: nodes.length, circles: circles.length };
    });
    results.push({ test: 'Topology shows hub node', ok: !!topoBefore.ok, detail: JSON.stringify(topoBefore) });
    log('2', 'Topology before join ' + JSON.stringify(topoBefore));

    log('3', 'Invalid join code should fail');
    const studentBad = await context.newPage();
    await studentBad.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await studentBad.waitForTimeout(800);
    await studentBad.fill('#joinCode', 'ZZZZ');
    await studentBad.selectOption('#roleSelect', 'participant').catch(() => {});
    await studentBad.click('#joinForm button[type="submit"]');
    await studentBad.waitForTimeout(9000);
    const badErr = await studentBad.locator('#joinError').textContent().catch(() => '');
    const stillOnLanding = /index\.html|\/lab\/?(\?|$)/i.test(studentBad.url());
    results.push({
      test: 'Invalid code blocked',
      ok: stillOnLanding && /no active|invalid|session/i.test(badErr || ''),
      detail: `url=${studentBad.url()} err=${badErr}`
    });
    await shot(studentBad, '03-invalid-join');
    await studentBad.close();

    log('4', 'Valid join as miner');
    const miner = await context.newPage();
    miner.on('console', (m) => {
      if (m.type() === 'error') console.log('[miner console error]', m.text());
    });
    await miner.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await miner.waitForTimeout(800);
    await miner.fill('#joinCode', code);
    await miner.selectOption('#roleSelect', 'participant').catch(() => {});
    await miner.click('#joinForm button[type="submit"]');
    // May take probe + navigate
    try {
      await miner.waitForURL(/participate/i, { timeout: 20000 });
      results.push({ test: 'Miner joined valid session', ok: true, detail: miner.url() });
    } catch (e) {
      const err = await miner.locator('#joinError').textContent().catch(() => '');
      results.push({ test: 'Miner joined valid session', ok: false, detail: err || miner.url() });
    }
    await miner.waitForTimeout(4000);
    await shot(miner, '04-miner');

    // Admin should see participant
    await admin.bringToFront();
    await admin.waitForTimeout(2000);
    await shot(admin, '05-admin-after-join');
    const participantsText = await admin.locator('#participantsTable, #participantList, table').first().innerText().catch(() => '');
    const participantCount = await admin.locator('#participantCount').textContent().catch(() => '');
    results.push({
      test: 'Admin sees participant after join',
      ok: /miner|user-|wallet/i.test(participantsText) || (parseInt(participantCount, 10) >= 1),
      detail: `count=${participantCount} table=${(participantsText || '').slice(0, 180)}`
    });

    const topoAfter = await admin.evaluate(() => {
      const svg = document.querySelector('#networkVisualizationSvg');
      if (!svg) return { ok: false };
      const nodes = svg.querySelectorAll('g.node');
      const lines = svg.querySelectorAll('line');
      return { ok: nodes.length >= 1, nodes: nodes.length, lines: lines.length };
    });
    results.push({ test: 'Topology updates after join', ok: !!topoAfter.ok, detail: JSON.stringify(topoAfter) });

    log('5', 'Start mining briefly');
    await miner.bringToFront();
    const mineVisible = await miner.locator('#mineBtn').isVisible().catch(() => false);
    if (mineVisible) {
      await miner.click('#mineBtn');
      await miner.waitForTimeout(8000);
      await shot(miner, '06-mining');
      const miningUi = await miner.locator('#miningActivity').innerText().catch(() => '');
      results.push({
        test: 'Mining UI active',
        ok: /mining|nonce|hashrate|progress/i.test(miningUi),
        detail: (miningUi || '').slice(0, 160)
      });
      if (await miner.locator('#stopMineBtn').isVisible().catch(() => false)) {
        await miner.click('#stopMineBtn').catch(() => {});
      }
    } else {
      results.push({ test: 'Mining UI active', ok: false, detail: 'mineBtn not visible' });
    }

    // Height on admin
    await admin.bringToFront();
    await admin.waitForTimeout(2000);
    const height = await admin.locator('#blockHeight').textContent().catch(() => '?');
    results.push({ test: 'Admin block height readable', ok: height != null, detail: 'height=' + height });
    await shot(admin, '07-admin-final');
  } catch (err) {
    results.push({ test: 'Smoke run completed', ok: false, detail: String(err && err.stack || err) });
    try { await shot(admin, '99-error'); } catch (e) {}
  } finally {
    await browser.close();
  }

  console.log('\n=== RESULTS ===');
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    if (r.ok) pass++; else fail++;
    console.log(`${mark}  ${r.test} — ${r.detail}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Screenshots in', OUT);
  process.exit(fail ? 1 : 0);
})();
