/**
 * Live / local check for p4fix11:
 *  - new sessions start at 3 leading zeros + 0x8
 *  - omitted chain heights stay browseable
 *
 * Usage:
 *   node scripts/p4fix11-live-test.js [baseUrl]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const LANDING = /index\.html$/i.test(BASE) ? BASE : (BASE.endsWith('/lab') ? BASE + '/' : BASE + '/index.html');
const OUT = path.join(__dirname, '..', 'tmp-audit-p4fix11');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function pass(n, d) { results.push({ ok: true, n, d: d || '' }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); }
function fail(n, d) { results.push({ ok: false, n, d: d || '' }); console.log('FAIL  ' + n + ' — ' + (d || '')); }

async function shot(page, name) {
  try { await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }); } catch (e) {}
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const admin = await context.newPage();
  admin.setDefaultTimeout(30000);

  try {
    await admin.goto(LANDING, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await admin.waitForTimeout(800);
    await admin.click('#createSessionBtn');
    await admin.waitForURL(/admin/i, { timeout: 30000 });
    await admin.waitForTimeout(1800);
    await shot(admin, '01-admin');

    const leading = await admin.locator('#difficultyLeading').inputValue();
    const leadingLabel = (await admin.locator('#difficultyLeadingValue').innerText()).trim();
    const secondary = await admin.locator('#difficultySecondary').inputValue();
    const secondaryLabel = (await admin.locator('#difficultySecondaryValue').innerText()).trim();
    if (leading === '3' && leadingLabel === '3') pass('Default leading zeros is 3', leading + ' / label ' + leadingLabel);
    else fail('Default leading zeros is 3', 'val=' + leading + ' label=' + leadingLabel);
    if (secondary === '8' && /^8$/i.test(secondaryLabel)) pass('Default secondary is 0x8', secondary + ' / label ' + secondaryLabel);
    else fail('Default secondary is 0x8', 'val=' + secondary + ' label=' + secondaryLabel);

    const hubDefault = await admin.evaluate(function () {
      var rs = window.relayState;
      if (!rs || !rs.settings) return null;
      return { L: rs.settings.difficultyLeading, S: rs.settings.difficultySecondary };
    });
    if (hubDefault && hubDefault.L === 3 && Number(hubDefault.S) === 8) {
      pass('Hub settings start at 3 + 0x8', JSON.stringify(hubDefault));
    } else {
      fail('Hub settings start at 3 + 0x8', JSON.stringify(hubDefault));
    }

    const injected = await admin.evaluate(function () {
      var rs = window.relayState;
      if (!rs) return { ok: false, reason: 'no relayState' };
      var chain = [];
      var prev = '0';
      for (var i = 0; i <= 24; i++) {
        var hash = i === 0 ? '0000000000000000000000000000000000000000000000000000000000000000' : ('h' + i + '000000000000');
        chain.push({
          index: i,
          hash: hash,
          previousHash: prev,
          miner: i === 0 ? 'genesis' : 'audit-miner',
          timestamp: Date.now() - (24 - i) * 1000,
          nonce: i,
          transactions: i === 12 ? [{ from: 'a', to: 'b', amount: 5 }] : []
        });
        prev = hash;
        if (rs.allBlocks && typeof rs.allBlocks.set === 'function') rs.allBlocks.set(hash, chain[i]);
      }
      rs.chain = chain;
      rs.networkStats.blockHeight = 24;
      if (typeof updateBlockchainView === 'function') {
        if (typeof window !== 'undefined') window._hubChainPaintKey = '';
        updateBlockchainView(chain, [], []);
      }
      return { ok: true, n: chain.length };
    });
    if (!injected || !injected.ok) {
      fail('Inject long chain for archive', JSON.stringify(injected));
    } else {
      pass('Inject long chain for archive', 'n=' + injected.n);
    }
    await admin.waitForTimeout(400);
    await shot(admin, '02-long-chain');

    const browse = admin.locator('[data-chain-archive-toggle]');
    const browseCount = await browse.count();
    const browseText = browseCount ? (await browse.first().innerText()) : '';
    if (browseCount && /Browse \d+ earlier block/i.test(browseText)) {
      pass('Browse earlier blocks control is visible', browseText.trim());
    } else {
      fail('Browse earlier blocks control is visible', 'count=' + browseCount + ' text=' + browseText);
    }

    if (browseCount) {
      await browse.first().click();
      await admin.waitForTimeout(250);
      const panelVisible = await admin.locator('.chain-archive-panel').isVisible();
      const rows = admin.locator('[data-chain-archive-hash]');
      const rowCount = await rows.count();
      const hashes = [];
      for (var i = 0; i < Math.min(rowCount, 8); i++) {
        hashes.push(await rows.nth(i).getAttribute('data-chain-archive-hash'));
      }
      if (panelVisible && rowCount >= 10) pass('Archive lists hidden heights', 'rows=' + rowCount + ' first=' + hashes[0]);
      else fail('Archive lists hidden heights', 'panel=' + panelVisible + ' rows=' + rowCount);

      if (rowCount) {
        const mid = rows.nth(Math.min(11, rowCount - 1));
        const midHash = await mid.getAttribute('data-chain-archive-hash');
        const midHeight = (await mid.locator('td').first().innerText()).trim();
        await mid.click();
        await admin.waitForTimeout(250);
        const detailText = (await admin.locator('.chain-archive-detail').innerText().catch(function () { return ''; })) || '';
        if (new RegExp('Block #' + midHeight).test(detailText)) {
          pass('Clicking an archive row shows that block', 'height ' + midHeight + ' hash ' + midHash);
        } else {
          fail('Clicking an archive row shows that block', detailText.replace(/\s+/g, ' ').slice(0, 200));
        }
      }
    }
    await shot(admin, '03-archive-open');

    const liveMid = await admin.locator('.chain-level[data-height="12"] .chain-block-col').count();
    const liveTip = await admin.locator('.chain-level[data-height="24"] .chain-block-col').count();
    const archiveMid = await admin.locator('[data-chain-archive-hash^="h12"]').count();
    if (liveTip > 0 && liveMid === 0 && archiveMid > 0) {
      pass('Live window still hides the middle as cards', 'tip cards=' + liveTip + ' mid cards=' + liveMid);
    } else {
      fail('Live window still hides the middle as cards',
        'tip=' + liveTip + ' midCards=' + liveMid + ' archiveMid=' + archiveMid);
    }
  } catch (e) {
    fail('p4fix11 live test threw', e && e.message ? e.message : String(e));
    await shot(admin, '99-crash');
  } finally {
    await browser.close();
  }

  const failed = results.filter(function (r) { return !r.ok; });
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ base: LANDING, results: results }, null, 2));
  if (failed.length) process.exit(1);
})();
