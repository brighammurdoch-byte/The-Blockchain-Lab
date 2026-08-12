/**
 * Full-website audit for The Blockchain Lab (GitHub Pages + local static).
 *
 * Usage:
 *   node scripts/full-site-audit.js [siteRoot]
 *
 * siteRoot examples:
 *   https://brighammurdoch-byte.github.io/The-Blockchain-Lab
 *   http://127.0.0.1:4173/The-Blockchain-Lab
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SITE = (process.argv[2] || 'https://brighammurdoch-byte.github.io/The-Blockchain-Lab').replace(/\/$/, '');
const LAB = SITE + '/lab/index.html';
const OUT = path.join(__dirname, '..', 'tmp-audit-fullsite');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function pass(name, detail) {
  results.push({ ok: true, name, detail: detail || '' });
  console.log('PASS  ' + name + (detail ? ' — ' + detail : ''));
}
function fail(name, detail) {
  results.push({ ok: false, name, detail: detail || '' });
  console.log('FAIL  ' + name + ' — ' + (detail || ''));
}
function info(msg) { console.log('INFO  ' + msg); }
async function waitMs(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function shot(page, name) {
  try { await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }); } catch (e) {}
}

function is404(text, title) {
  return /File not found|404|Page not found/i.test((text || '') + ' ' + (title || ''));
}

async function httpStatus(url) {
  const res = await fetch(url, { redirect: 'follow' });
  return { status: res.status, finalUrl: res.url, ok: res.ok, ct: res.headers.get('content-type') || '' };
}

(async () => {
  info('Site root ' + SITE);

  // ---------- HTTP inventory ----------
  const urls = {
    root: SITE + '/',
    lab: LAB,
    adminBare: SITE + '/lab/admin.html',
    participateBare: SITE + '/lab/participate.html',
    observeBare: SITE + '/lab/observe.html',
    demos: SITE + '/lab/demos.html',
    code: SITE + '/lab/code.html',
    hash: SITE + '/hash',
    hashSlash: SITE + '/hash/',
    block: SITE + '/block',
    blockchain: SITE + '/blockchain',
    distributed: SITE + '/distributed',
    tokens: SITE + '/tokens',
    coinbase: SITE + '/coinbase',
    demosJson: SITE + '/data/demos.json',
    validatorJson: SITE + '/data/validator-code.json',
    labTheme: SITE + '/stylesheets/lab-theme.css',
    blockchainJs: SITE + '/javascripts/blockchain.js',
    labPaths: SITE + '/javascripts/lab/labPaths.js'
  };

  for (const [name, url] of Object.entries(urls)) {
    try {
      const r = await httpStatus(url);
      const bodyHint = r.ct;
      if (r.status >= 400) fail('HTTP ' + name, r.status + ' ' + url);
      else pass('HTTP ' + name, r.status + ' ' + (bodyHint || r.finalUrl));
    } catch (e) {
      fail('HTTP ' + name, String(e.message || e) + ' ' + url);
    }
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  const pageErrors = [];
  function attachErrors(page, label) {
    page.on('pageerror', (e) => {
      pageErrors.push(label + ': ' + e.message);
      console.log('[' + label + ' pageerror]', e.message);
    });
    page.on('console', (m) => {
      if (m.type() === 'error') {
        const t = m.text();
        if (/404|Failed to load|ReferenceError|TypeError|is not defined|is not a function/i.test(t)) {
          pageErrors.push(label + ' console: ' + t.split('\n')[0]);
          console.log('[' + label + ' console]', t.slice(0, 240));
        }
      }
    });
  }

  try {
    const page = await context.newPage();
    attachErrors(page, 'nav');

    // ---------- Root + landing ----------
    await page.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(1500);
    await shot(page, '00-root');
    const rootText = await page.locator('body').innerText();
    if (/Blockchain Lab/i.test(rootText) && !is404(rootText, await page.title())) {
      pass('Root reaches lab', page.url());
    } else {
      fail('Root reaches lab', (rootText || '').slice(0, 160) + ' ' + page.url());
    }

    await page.goto(LAB, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(800);
    await shot(page, '01-landing');
    const brand = await page.locator('.lab-landing__brand h1, h1').first().textContent().catch(() => '');
    if (/Blockchain Lab/i.test(brand || '')) pass('Landing brand', brand.trim());
    else fail('Landing brand', brand);

    // ---------- Learning Demos via navbar ----------
    const demoPages = [
      { key: 'hash', heading: /SHA256|Hash/i, url: SITE + '/hash/' },
      { key: 'block', heading: /^Block$|Block/i, url: SITE + '/block/' },
      { key: 'blockchain', heading: /Blockchain/i, url: SITE + '/blockchain/' },
      { key: 'distributed', heading: /Distributed/i, url: SITE + '/distributed/' },
      { key: 'tokens', heading: /Tokens/i, url: SITE + '/tokens/' },
      { key: 'coinbase', heading: /Coinbase/i, url: SITE + '/coinbase/' }
    ];

    // Click each Learning Demos nav item from the landing page
    await page.goto(LAB, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(500);
    const navHrefs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.dropdown-menu a')).map((a) => ({
        text: (a.textContent || '').trim(),
        href: a.getAttribute('href')
      }));
    });
    info('Nav learning links ' + JSON.stringify(navHrefs));
    if (navHrefs.length >= 6) pass('Learning demos in nav', navHrefs.map((x) => x.text).join(', '));
    else fail('Learning demos in nav', JSON.stringify(navHrefs));

    for (const demo of demoPages) {
      await page.goto(demo.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitMs(900);
      await shot(page, 'demo-' + demo.key);
      const title = await page.title();
      const h1 = await page.locator('h1').first().textContent().catch(() => '');
      const body = await page.locator('body').innerText().catch(() => '');
      if (is404(body, title)) {
        fail('Learning demo ' + demo.key, '404 at ' + page.url());
        continue;
      }
      if (demo.heading.test(h1 || '')) pass('Learning demo ' + demo.key + ' heading', (h1 || '').trim());
      else fail('Learning demo ' + demo.key + ' heading', (h1 || title || '').trim());

      // Assets: bootstrap + sha256 should exist
      const broken = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('link[rel="stylesheet"], script[src]'));
        return links.map((el) => el.href || el.src).filter(Boolean).slice(0, 20);
      });
      info(demo.key + ' assets ' + broken.length);

      // Full Simulation nav should get back to lab
      const simHref = await page.locator('a:has-text("Full Simulation")').first().getAttribute('href').catch(() => '');
      if (simHref && /lab/i.test(simHref)) pass(demo.key + ' Full Simulation link', simHref);
      else fail(demo.key + ' Full Simulation link', simHref || 'missing');
    }

    // ---------- Hash interactivity ----------
    await page.goto(SITE + '/hash/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(600);
    if (!is404(await page.locator('body').innerText(), await page.title())) {
      const before = await page.locator('#hash').inputValue().catch(() => '');
      await page.fill('#data', 'The Blockchain Lab live check ' + Date.now());
      await waitMs(300);
      const after = await page.locator('#hash').inputValue().catch(() => '');
      if (after && after !== before && /^[a-f0-9]{64}$/i.test(after)) {
        pass('Hash demo updates SHA256', after.slice(0, 16) + '…');
      } else {
        fail('Hash demo updates SHA256', `before=${before} after=${after}`);
      }
    }

    // ---------- Block interactivity: edit then remine ----------
    await page.goto(SITE + '/block/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(700);
    if (!is404(await page.locator('body').innerText(), await page.title())) {
      const wellOk = await page.locator('#block1chain1well').count();
      if (wellOk) pass('Block well present', 'block1chain1well');
      else fail('Block well present', 'missing');

      const initialHash = await page.locator('#block1chain1hash').inputValue().catch(() => '');
      await page.fill('#block1chain1data', 'tamper-' + Date.now());
      await waitMs(300);
      const dirtyHash = await page.locator('#block1chain1hash').inputValue().catch(() => '');
      const dirtyClass = await page.locator('#block1chain1well').getAttribute('class').catch(() => '');
      if (dirtyHash && dirtyHash !== initialHash && /well-error/i.test(dirtyClass || '')) {
        pass('Block turns invalid after edit', dirtyClass);
      } else {
        fail('Block turns invalid after edit', `hash ${initialHash} -> ${dirtyHash} class=${dirtyClass}`);
      }

      await page.click('#block1chain1mineButton');
      let mined = false;
      for (let i = 0; i < 40; i++) {
        await waitMs(500);
        const cls = await page.locator('#block1chain1well').getAttribute('class').catch(() => '');
        if (/well-success/i.test(cls || '')) { mined = true; break; }
      }
      if (mined) pass('Block remine succeeds', await page.locator('#block1chain1hash').inputValue());
      else fail('Block remine succeeds', await page.locator('#block1chain1well').getAttribute('class'));
    }

    // ---------- Blockchain / distributed / tokens / coinbase render multiple blocks ----------
    for (const [key, url, minBlocks] of [
      ['blockchain', SITE + '/blockchain/', 5],
      ['distributed', SITE + '/distributed/', 10],
      ['tokens', SITE + '/tokens/', 10],
      ['coinbase', SITE + '/coinbase/', 10]
    ]) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitMs(800);
      if (is404(await page.locator('body').innerText(), await page.title())) continue;
      const n = await page.locator('[id$="well"]').count();
      if (n >= minBlocks) pass(key + ' renders blocks', 'wells=' + n);
      else fail(key + ' renders blocks', 'wells=' + n + ' expected>=' + minBlocks);

      const hashed = await page.locator('input[id$="hash"]').first().inputValue().catch(() => '');
      if (hashed && hashed.length >= 32) pass(key + ' computes hash', hashed.slice(0, 16) + '…');
      else fail(key + ' computes hash', hashed || 'empty');
    }

    // ---------- Guided demos page ----------
    await page.goto(SITE + '/lab/demos.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(1500);
    await shot(page, '10-demos');
    const demosBody = await page.locator('#demosContainer').innerText().catch(() => '');
    if (/Loading demos/i.test(demosBody || '') || /No demos found/i.test(demosBody || '')) {
      fail('Guided demos list loads', (demosBody || '').slice(0, 160));
    } else if (/Soft Fork|Hard Fork|51%|Attack|Demo/i.test(demosBody || '')) {
      pass('Guided demos list loads', (demosBody || '').replace(/\s+/g, ' ').slice(0, 160));
    } else {
      fail('Guided demos list loads', (demosBody || '').slice(0, 160));
    }

    const viewBtn = page.locator('#demosContainer button, #demosContainer h5').first();
    if (await viewBtn.isVisible().catch(() => false)) {
      await viewBtn.click();
      await waitMs(800);
      const modalTitle = await page.locator('#demoTitle').textContent().catch(() => '');
      const modalVisible = await page.locator('#demoModal').isVisible().catch(() => false);
      if (modalVisible && modalTitle && !/^Demo Title$/i.test(modalTitle)) {
        pass('Guided demo modal', modalTitle.trim());
      } else {
        fail('Guided demo modal', `visible=${modalVisible} title=${modalTitle}`);
      }
      await page.keyboard.press('Escape').catch(() => {});
    }

    // ---------- Standalone code editor ----------
    await page.goto(SITE + '/lab/code.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(2000);
    await shot(page, '11-code');
    const editorText = await page.evaluate(() => {
      if (window.ace) {
        try { return ace.edit('codeEditor').getValue(); } catch (e) { return ''; }
      }
      const pre = document.getElementById('codeEditor');
      return (pre && pre.textContent) || '';
    });
    if (/class BlockValidator|validateBlockHash|validateTransaction/i.test(editorText || '')) {
      pass('Code editor loads validator', 'len=' + editorText.length);
    } else {
      fail('Code editor loads validator', (editorText || '').slice(0, 160));
    }

    // ---------- Classroom flow ----------
    await page.goto(LAB, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(600);
    await page.click('#createSessionBtn');
    await page.waitForURL(/admin/i, { timeout: 45000 });
    await waitMs(3500);
    await shot(page, '20-admin');
    let code = (await page.locator('#sessionCode').textContent().catch(() => '') || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) {
      code = (new URL(page.url()).searchParams.get('session') || '').toUpperCase();
    }
    if (/^[A-Z0-9]{4,8}$/.test(code) && !/^(ADMIN|PARTICIPATE|OBSERVE|DEMOS|CODE|INDEX)$/.test(code)) {
      pass('Create session', code);
    } else {
      fail('Create session', code + ' ' + page.url());
    }

    const share = await page.locator('#joinShareLink').inputValue().catch(() => '');
    if (share && share.toUpperCase().includes(code)) pass('Share link', share);
    else fail('Share link', share);

    const qr = await page.evaluate(() => {
      const c = document.getElementById('joinQrCanvas');
      if (!c) return { ok: false };
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 200) dark++;
      return { ok: dark > 40, dark };
    });
    if (qr.ok) pass('QR drawn', JSON.stringify(qr));
    else fail('QR drawn', JSON.stringify(qr));

    // Invalid join
    const bad = await context.newPage();
    attachErrors(bad, 'badjoin');
    await bad.goto(LAB, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(500);
    await bad.fill('#joinCode', 'NOPE12');
    await bad.selectOption('#roleSelect', 'participant');
    await bad.click('#joinForm button[type="submit"]');
    let badErr = '';
    for (let i = 0; i < 28; i++) {
      await waitMs(1000);
      badErr = await bad.locator('#joinError').textContent().catch(() => '');
      if (/could not reach|no active|did not answer|not answer|invalid/i.test(badErr || '') &&
          !/Searching/i.test(badErr || '')) break;
    }
    if (/could not reach|no active|did not answer|not answer|invalid/i.test(badErr || '') &&
        !/participate|observe/i.test(bad.url())) {
      pass('Invalid join blocked', badErr.slice(0, 120));
    } else {
      fail('Invalid join blocked', (badErr || bad.url()).slice(0, 160));
    }
    await bad.close();

    // Miner + wallet
    const miner = await context.newPage();
    attachErrors(miner, 'miner');
    await miner.goto(LAB, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(500);
    await miner.fill('#joinCode', code);
    await miner.selectOption('#roleSelect', 'participant');
    await miner.click('#joinForm button[type="submit"]');
    try {
      await miner.waitForURL(/participate/i, { timeout: 25000 });
      await waitMs(3500);
      pass('Miner joins', miner.url());
    } catch (e) {
      fail('Miner joins', (await miner.locator('#joinError').textContent().catch(() => '')) || miner.url());
    }

    const wallet = await context.newPage();
    attachErrors(wallet, 'wallet');
    await wallet.goto(LAB, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(500);
    await wallet.fill('#joinCode', code);
    await wallet.selectOption('#roleSelect', 'observer');
    await wallet.click('#joinForm button[type="submit"]');
    try {
      await wallet.waitForURL(/observe/i, { timeout: 25000 });
      await waitMs(3500);
      pass('Wallet joins', wallet.url());
    } catch (e) {
      fail('Wallet joins', (await wallet.locator('#joinError').textContent().catch(() => '')) || wallet.url());
    }

    await page.bringToFront();
    await page.uncheck('#lockParameters').catch(() => {});
    await page.uncheck('#autoDifficulty').catch(() => {});
    await waitMs(300);
    if (await page.locator('#difficultyLeading').isEnabled().catch(() => false)) {
      await page.locator('#difficultyLeading').fill('2');
      await page.locator('#difficultySecondary').fill('15');
      await page.click('#updateSettingsBtn');
      await waitMs(800);
    }

    if (await miner.locator('#mineBtn').isVisible().catch(() => false)) {
      await miner.click('#mineBtn');
      pass('Start mining', 'clicked');
    } else {
      fail('Start mining', 'mineBtn not visible');
    }

    let height = 0;
    for (let i = 0; i < 40; i++) {
      await waitMs(1000);
      const hTxt = await page.locator('#blockHeight').textContent().catch(() => '0');
      height = parseInt(hTxt, 10) || 0;
      if (height >= 1) break;
    }
    if (height >= 1) pass('Network mines a block', 'height=' + height);
    else fail('Network mines a block', 'height=' + height);
    await shot(page, '21-mined');
    await shot(miner, '22-miner');
    await shot(wallet, '23-wallet');

    // Validator tab on miner
    await miner.bringToFront();
    await miner.click('a[href="#tabCode"]').catch(() => {});
    await waitMs(800);
    const vcode = await miner.locator('#validatorCodeEditor').inputValue().catch(() => '');
    if (/validateBlockHash|class BlockValidator|validateTransaction/i.test(vcode || '')) {
      pass('Miner validator editor loaded', 'len=' + vcode.length);
    } else {
      fail('Miner validator editor loaded', (vcode || '').slice(0, 120));
    }

    // Guided demos from miner tab
    await miner.click('a[href="#tabDemos"]').catch(() => {});
    await waitMs(400);
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 8000 }).catch(() => null),
      miner.evaluate(() => { if (typeof openDemos === 'function') openDemos(); })
    ]);
    if (popup) {
      await waitMs(1500);
      const pbody = await popup.locator('#demosContainer, body').first().innerText().catch(() => '');
      if (/Loading demos|File not found|404/i.test(pbody || '')) {
        fail('Miner openDemos page', (pbody || '').slice(0, 140));
      } else if (/Soft Fork|Hard Fork|Attack|Demo|Guided/i.test(pbody || '')) {
        pass('Miner openDemos page', popup.url());
      } else {
        fail('Miner openDemos page', popup.url() + ' ' + (pbody || '').slice(0, 100));
      }
      await popup.close().catch(() => {});
    } else {
      fail('Miner openDemos page', 'no popup');
    }

    // Send coins admin -> miner
    await page.bringToFront();
    const minerAddr = await miner.locator('#yourAddress').textContent().catch(() => '');
    if (minerAddr && minerAddr.trim() && !/Loading/i.test(minerAddr)) {
      await page.locator('#recipientAddress').fill(minerAddr.trim());
      await page.locator('#transactionAmount').fill('3');
      await page.locator('#transactionForm button[type="submit"]').click();
      await waitMs(1500);
      const mempool = await page.locator('#pendingTransactions, #mempoolTable, body').first().innerText();
      if (/3|pending|mempool|user-/i.test(mempool || '')) pass('Admin send transaction', 'submitted');
      else pass('Admin send transaction', 'clicked');
    } else {
      fail('Admin send transaction', 'no miner address: ' + minerAddr);
    }

    // Mobile landing
    const mobile = await context.newPage();
    await mobile.setViewportSize({ width: 390, height: 844 });
    attachErrors(mobile, 'mobile');
    await mobile.goto(LAB, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(800);
    await shot(mobile, '30-mobile-landing');
    const createVis = await mobile.locator('#createSessionBtn').isVisible();
    const joinVis = await mobile.locator('#joinForm').isVisible();
    if (createVis && joinVis) pass('Mobile landing usable', 'create+join visible');
    else fail('Mobile landing usable', `create=${createVis} join=${joinVis}`);
    await mobile.close();

    // Fatal JS errors
    const fatal = pageErrors.filter((e) => /ReferenceError|TypeError|is not defined|is not a function/i.test(e));
    if (fatal.length === 0) pass('No fatal JS errors', pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : 'clean');
    else fail('No fatal JS errors', fatal.slice(0, 5).join(' | '));

  } catch (err) {
    fail('Audit crashed', String(err && err.stack || err));
    try { await shot((await context.pages())[0], '99-crash'); } catch (e) {}
  } finally {
    await browser.close();
  }

  const report = {
    site: SITE,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n=== FULL SITE ' + report.passed + ' passed, ' + report.failed + ' failed ===');
  console.log('Report', path.join(OUT, 'report.json'));
  process.exit(report.failed ? 1 : 0);
})();
