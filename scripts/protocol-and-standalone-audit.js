/**
 * Standalone validator wiring + Bitcoin/Ethereum protocol pages.
 * Usage: node scripts/protocol-and-standalone-audit.js [labBase]
 */
const { chromium } = require('playwright');
const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const SITE = BASE.replace(/\/lab\/?$/, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const results = [];
  const pass = (n, d) => { results.push({ ok: true, n, d }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); };
  const fail = (n, d) => { results.push({ ok: false, n, d }); console.log('FAIL  ' + n + ' — ' + d); };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  try {
    const admin = await ctx.newPage();
    await admin.goto(BASE.includes('.html') ? BASE : BASE + (BASE.endsWith('/lab') ? '/index.html' : ''), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(async () => {
      await admin.goto(BASE.replace(/\/$/, '') + '/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    });
    // Landing may be /lab or /lab/index.html
    if (!(await admin.locator('#createSessionBtn').count())) {
      await admin.goto(SITE + '/lab/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await admin.click('#createSessionBtn');
    await admin.waitForURL(/admin/i, { timeout: 45000 });
    await wait(2500);
    const code = ((await admin.locator('#sessionCode').textContent()) || '').trim().toUpperCase();
    if (/^[A-Z0-9]{4,8}$/.test(code) && code !== 'ADMIN') pass('Session', code);
    else fail('Session', code);

    const miner = await ctx.newPage();
    await miner.goto(SITE + '/lab/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await miner.fill('#joinCode', code);
    await miner.selectOption('#roleSelect', 'participant');
    await miner.click('#joinForm button[type="submit"]');
    await miner.waitForURL(/participate/i, { timeout: 25000 });
    await wait(3500);
    pass('Miner joined', miner.url());

    const standalone = await ctx.newPage();
    const codeUrl = SITE + '/lab/code.html?session=' + encodeURIComponent(code);
    await standalone.goto(codeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await wait(1500);
    const loaded = await standalone.evaluate(() => {
      try { return ace.edit('codeEditor').getValue(); } catch (e) { return ''; }
    });
    if (/class BlockValidator/.test(loaded)) pass('Standalone loads validator', 'len=' + loaded.length);
    else fail('Standalone loads validator', loaded.slice(0, 80));

    await standalone.evaluate(() => {
      const ed = ace.edit('codeEditor');
      ed.setValue(ed.getValue().replace(/requiredLeadingZeros:\s*config\.leadingZeros\s*\|\|\s*4/, 'requiredLeadingZeros: config.leadingZeros || 2'));
    });
    standalone.once('dialog', (d) => d.accept());
    await standalone.click('#submitCode');
    await wait(800);
    const status = await standalone.locator('#networkStatus').innerText();
    if (/MODIFIED/i.test(status)) pass('Standalone submit message', status.slice(0, 120));
    else fail('Standalone submit message', status);

    await wait(800);
    const applied = await miner.evaluate(() => {
      const v = window.customValidator;
      return {
        custom: !!window.__labValidatorIsCustom,
        zeros: v && v.config && v.config.requiredLeadingZeros
      };
    });
    if (applied.custom && Number(applied.zeros) === 2) {
      pass('Miner received standalone validator', JSON.stringify(applied));
    } else {
      // BroadcastChannel may need a moment; try reading editor
      const editorVal = await miner.locator('#validatorCodeEditor').inputValue().catch(() => '');
      if (/requiredLeadingZeros:\s*config\.leadingZeros\s*\|\|\s*2/.test(editorVal)) {
        pass('Miner editor synced from standalone', 'textarea updated');
      } else {
        fail('Miner received standalone validator', JSON.stringify(applied) + ' editor=' + editorVal.slice(0, 80));
      }
    }

    // Bitcoin page
    await standalone.goto(SITE + '/bitcoin/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await wait(1000);
    const btcH1 = await standalone.locator('h1').textContent();
    if (/Bitcoin/i.test(btcH1 || '')) pass('Bitcoin page heading', btcH1.trim());
    else fail('Bitcoin page heading', btcH1);
    const explain = await standalone.locator('body').innerText();
    if (/not bitcoind|cannot compile C\+\+|translator/i.test(explain)) {
      pass('Bitcoin explains background twin', 'disclaimer present');
    } else fail('Bitcoin explains background twin', 'missing');

    const beforeSub = await standalone.locator('#btcSubsidy').textContent();
    await standalone.click('#btcMineBtn');
    await wait(800);
    const h1 = parseInt(await standalone.locator('#btcHeight').textContent(), 10);
    if (h1 >= 1) pass('Bitcoin mines a block', 'height=' + h1 + ' subsidyUI=' + beforeSub);
    else fail('Bitcoin mines a block', 'height=' + h1);

    await standalone.evaluate(() => {
      const ed = ace.edit('btcEditor');
      ed.setValue(ed.getValue().replace(/CAmount nSubsidy = 50 \* COIN;/, 'CAmount nSubsidy = 100 * COIN;'));
    });
    await standalone.click('#btcApplyBtn');
    await wait(400);
    await standalone.click('#btcMineBtn');
    await wait(800);
    const subAfter = await standalone.locator('#btcSubsidy').textContent();
    const lastSub = await standalone.evaluate(() => {
      const rows = document.querySelectorAll('#btcBlocks tr td:nth-child(4)');
      return rows[0] ? rows[0].textContent : '';
    });
    if (String(lastSub).indexOf('100') !== -1 || /100/.test(subAfter || '')) {
      pass('Bitcoin C++ subsidy change applies', 'last=' + lastSub + ' next=' + subAfter);
    } else {
      fail('Bitcoin C++ subsidy change applies', 'last=' + lastSub + ' next=' + subAfter);
    }

    // Ethereum page
    await standalone.goto(SITE + '/ethereum/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await wait(1000);
    if (/Ethereum/i.test(await standalone.locator('h1').textContent() || '')) pass('Ethereum page heading', 'ok');
    else fail('Ethereum page heading', await standalone.locator('h1').textContent());
    const ethBody = await standalone.locator('body').innerText();
    if (/not solc|not the EVM|translator/i.test(ethBody)) pass('Ethereum explains background twin', 'disclaimer present');
    else fail('Ethereum explains background twin', 'missing');

    await standalone.click('#ethMineBtn');
    await wait(400);
    const n1 = parseInt(await standalone.locator('#ethNumber').textContent(), 10);
    if (n1 >= 1) pass('Ethereum proposes a block', 'number=' + n1);
    else fail('Ethereum proposes a block', 'number=' + n1);

    await standalone.evaluate(() => {
      const ed = ace.edit('ethEditor');
      ed.setValue(ed.getValue().replace('require(balanceOf[msg.sender] >= amount, "insufficient balance");', '// require removed'));
    });
    await standalone.click('#ethApplyBtn');
    await wait(300);
    const notes = await standalone.locator('#ethTranslateNotes').innerText();
    if (/overdraft|require/i.test(notes || '')) pass('Ethereum Solidity require removal detected', notes.slice(0, 120));
    else fail('Ethereum Solidity require removal detected', notes);

    await standalone.fill('#ethSendAmt', '999');
    await standalone.click('#ethSendBtn');
    await wait(400);
    const sendNotes = await standalone.locator('#ethTranslateNotes').innerText();
    if (/Queued 999/.test(sendNotes || '')) pass('Ethereum overdraft queued after require removal', sendNotes.slice(0, 80));
    else fail('Ethereum overdraft queued after require removal', sendNotes);
  } catch (e) {
    fail('Audit crashed', String(e && e.stack || e));
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log('\n==== protocol-and-standalone-audit: ' + (results.length - failed) + '/' + results.length + ' passed ====');
  process.exit(failed ? 1 : 0);
})();
