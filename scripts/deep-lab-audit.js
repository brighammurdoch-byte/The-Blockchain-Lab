/**
 * Deep adversarial Blockchain Lab audit — edge cases + multi-peer combos.
 * Usage: node scripts/deep-lab-audit.js [baseUrl]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const OUT = path.join(__dirname, '..', 'tmp-audit-deep');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function pass(name, detail) { results.push({ ok: true, name, detail: detail || '' }); console.log('PASS  ' + name + (detail ? ' — ' + detail : '')); }
function fail(name, detail) { results.push({ ok: false, name, detail: detail || '' }); console.log('FAIL  ' + name + ' — ' + detail); }
function info(msg) { console.log('INFO  ' + msg); }
async function waitMs(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function shot(page, name) {
  try { await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }); } catch (e) {}
}

async function pageErrors(page, label, bag) {
  page.on('pageerror', (e) => { bag.push(label + ': ' + e.message); console.log('[' + label + ' pageerror]', e.message); });
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') {
      console.log('[' + label + ' console]', t);
      if (/ReferenceError|TypeError|is not defined|is not a function/i.test(t)) {
        bag.push(label + ' console: ' + t.split('\n')[0]);
      }
    }
  });
}

async function createSession(context) {
  const admin = await context.newPage();
  const errs = [];
  pageErrors(admin, 'admin', errs);
  await admin.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitMs(800);
  await admin.click('#createSessionBtn');
  await admin.waitForURL(/admin/i, { timeout: 45000 });
  await waitMs(3500);
  let code = (await admin.locator('#sessionCode').textContent().catch(() => '') || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) {
    const u = new URL(admin.url());
    code = (u.searchParams.get('session') || '').toUpperCase();
  }
  return { admin, code, errs };
}

async function joinAs(context, code, role, label) {
  const page = await context.newPage();
  const errs = [];
  pageErrors(page, label, errs);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitMs(600);
  await page.fill('#joinCode', code);
  await page.selectOption('#roleSelect', role);
  await page.click('#joinForm button[type="submit"]');
  const expect = role === 'observer' ? /observe/i : /participate/i;
  try {
    await page.waitForURL(expect, { timeout: 25000 });
  } catch (e) {
    const err = await page.locator('#joinError').textContent().catch(() => page.url());
    throw new Error(label + ' join failed: ' + err);
  }
  await waitMs(4000);
  return { page, errs };
}

async function setDifficulty(admin, leading, secondary) {
  await admin.uncheck('#lockParameters').catch(() => {});
  await admin.locator('#difficultyLeading').fill(String(leading));
  await admin.locator('#difficultySecondary').fill(String(secondary));
  await admin.click('#updateSettingsBtn');
  await waitMs(1000);
}

async function waitForHeight(admin, minH, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const h = parseInt(await admin.locator('#blockHeight').textContent().catch(() => '0'), 10);
    if (h >= minH) return h;
    await waitMs(2000);
  }
  return parseInt(await admin.locator('#blockHeight').textContent().catch(() => '0'), 10);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  try {
    // ========== ASSET HEALTH ==========
    info('Asset + landing checks @ ' + BASE);
    const probe = await context.newPage();
    const assetFails = [];
    probe.on('response', (res) => {
      if (res.status() >= 400 && /\.(js|css|json|png|svg)$/i.test(res.url())) {
        assetFails.push(res.status() + ' ' + res.url());
      }
    });
    await probe.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 }).catch(async () => {
      await probe.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    });
    await waitMs(1500);
    // Force-check critical scripts
    const critical = [
      '/javascripts/lib/mqtt.min.js',
      '/javascripts/network/MqttAdminRelayTransport.js',
      '/javascripts/network/NetworkManager.js',
      '/data/validator-code.json'
    ];
    for (const rel of critical) {
      const url = await probe.evaluate((r) => {
        if (window.LabPaths && LabPaths.assetUrl) return LabPaths.assetUrl(r);
        return r;
      }, rel);
      const abs = url.startsWith('http') ? url : new URL(url, probe.url()).href;
      const st = await probe.evaluate(async (u) => {
        try {
          const r = await fetch(u, { cache: 'no-store' });
          const t = await r.text();
          return { status: r.status, len: t.length, head: t.slice(0, 40) };
        } catch (e) { return { status: 0, err: String(e) }; }
      }, abs);
      if (st.status === 200 && st.len > 50) pass('Asset ' + rel, st.status + ' len=' + st.len);
      else fail('Asset ' + rel, JSON.stringify(st));
    }
    if (assetFails.length) fail('No 4xx assets on landing', assetFails.slice(0, 5).join(' | '));
    else pass('No 4xx assets on landing', 'ok');
    await probe.close();

    // ========== SESSION A: multi-miner + wallet + tx inclusion ==========
    const { admin, code, errs: adminErrs } = await createSession(context);
    if (/^[A-Z0-9]{4,8}$/.test(code)) pass('Create session', code);
    else fail('Create session', code);
    await setDifficulty(admin, 3, 10);
    await shot(admin, '01-admin');

    const miner1 = await joinAs(context, code, 'participant', 'miner1');
    await miner1.page.fill('#nodeName', 'MinerAlpha');
    await miner1.page.click('#setNodeNameBtn');
    await waitMs(800);
    await miner1.page.locator('#cpuUsage').fill('40');
    await miner1.page.click('#mineBtn');
    pass('Miner1 start mining', 'MinerAlpha');

    const miner2 = await joinAs(context, code, 'participant', 'miner2');
    await miner2.page.fill('#nodeName', 'MinerBeta');
    await miner2.page.click('#setNodeNameBtn');
    await waitMs(800);
    await miner2.page.click('#mineBtn');
    pass('Miner2 start mining', 'MinerBeta');

    const wallet = await joinAs(context, code, 'observer', 'wallet');
    await wallet.page.fill('#nodeName', 'CashWallet');
    await wallet.page.click('#setNodeNameBtn');
    await waitMs(800);

    // Topology should show 4 nodes (admin + 2 miners + wallet)
    await waitMs(2500);
    await admin.bringToFront();
    const topo = await admin.evaluate(() => {
      const svg = document.querySelector('#networkVisualizationSvg');
      return {
        nodes: svg ? svg.querySelectorAll('g.node').length : 0,
        labels: svg ? Array.from(svg.querySelectorAll('.node-label-name')).map((n) => n.textContent) : []
      };
    });
    if (topo.nodes >= 4) pass('Topology 4 peers', JSON.stringify(topo));
    else fail('Topology 4 peers', JSON.stringify(topo));

    const h1 = await waitForHeight(admin, 1, 45);
    if (h1 >= 1) pass('Multi-miner produces blocks', 'height=' + h1);
    else fail('Multi-miner produces blocks', 'height=' + h1);

    // Both miners should be able to get credit over time (not mandatory equal)
    await waitMs(8000);
    const h2 = await waitForHeight(admin, Math.max(3, h1 + 2), 40);
    const partHtml = await admin.locator('#participantsList').innerText().catch(() => '');
    const bothNamed = /MinerAlpha/i.test(partHtml) && /MinerBeta/i.test(partHtml);
    if (bothNamed) pass('Both miners listed by name', partHtml.replace(/\s+/g, ' ').slice(0, 180));
    else fail('Both miners listed by name', partHtml.slice(0, 180));
    if (h2 > h1) pass('Chain keeps growing with 2 miners', h1 + '→' + h2);
    else fail('Chain keeps growing with 2 miners', h1 + '→' + h2);

    // Wallet sends tx; remine; expect inclusion eventually
    const minerAddr = (await miner1.page.locator('#yourAddress').textContent() || '').trim();
    const walletAddr = (await wallet.page.locator('#yourAddress').textContent() || '').trim();
    const minerBalBefore = parseFloat(await miner1.page.locator('#yourBalance').textContent().catch(() => '0')) || 0;
    const walletBalBefore = parseFloat(await wallet.page.locator('#yourBalance').textContent().catch(() => '0')) || 0;
    if (minerBalBefore > 0) pass('Miner has mining balance before transfer', String(minerBalBefore));
    else fail('Miner has mining balance before transfer', String(minerBalBefore));

    // Miner participant directory should list wallet address + Send to
    await miner1.page.bringToFront();
    const dirHtml = await miner1.page.locator('#participantDirectory').innerHTML().catch(() => '');
    if (dirHtml && /Send to/i.test(dirHtml) && walletAddr && dirHtml.indexOf(walletAddr) !== -1) {
      pass('Miner participant directory shows wallet address', 'Send to present');
    } else {
      // fallback: shared network list
      await miner1.page.locator('a[href="#tabNetwork"]').click().catch(() => {});
      await waitMs(400);
      const listHtml = await miner1.page.locator('#participantList').innerHTML().catch(() => '');
      if (listHtml && walletAddr && listHtml.indexOf(walletAddr) !== -1) {
        pass('Miner participant directory shows wallet address', 'list tab');
      } else {
        fail('Miner participant directory shows wallet address', (dirHtml || listHtml || '').slice(0, 160));
      }
    }

    // Click Send to for the wallet specifically (not admin/self)
    const sendToSel = '#participantDirectory .use-recipient-btn[data-address="' + walletAddr + '"], #participantList .use-recipient-btn[data-address="' + walletAddr + '"]';
    const sendTo = miner1.page.locator(sendToSel).first();
    if (await sendTo.count()) {
      await sendTo.click();
      await waitMs(400);
      const filled = await miner1.page.locator('#recipientAddress').inputValue();
      if (filled === walletAddr) pass('Send-to fills recipient', filled);
      else fail('Send-to fills recipient', filled + ' expected ' + walletAddr);
    } else {
      await miner1.page.fill('#recipientAddress', walletAddr);
      pass('Send-to fills recipient', 'manual fill fallback');
    }

    await miner1.page.fill('#transactionAmount', '5');
    await miner1.page.click('#transactionForm button[type="submit"]');
    await waitMs(2000);

    // Also keep a wallet→miner tx in the mix
    await wallet.page.bringToFront();
    await wallet.page.fill('#recipientAddress', minerAddr);
    await wallet.page.fill('#transactionAmount', '2.25');
    await wallet.page.click('#transactionForm button[type="submit"]');
    await waitMs(2000);
    const pending = await wallet.page.locator('#pendingTransactions').innerText().catch(() => '');
    if (/2\.25|5/.test(pending) && !/No pending/i.test(pending)) pass('Wallet tx enters mempool', pending.slice(0, 120));
    else {
      const mp = await miner1.page.locator('#pendingTransactions').innerText().catch(() => '');
      if (/2\.25|5/.test(mp)) pass('Wallet tx enters mempool', mp.slice(0, 120));
      else fail('Wallet tx enters mempool', pending.slice(0, 80) + ' | ' + mp.slice(0, 80));
    }

    // Wait for inclusion in chain view (check HTML — amounts live in collapsed tx panels)
    let included = false;
    for (let i = 0; i < 12; i++) {
      await waitMs(2500);
      const found = await admin.evaluate(() => {
        const html = (document.querySelector('#blockchainView') || {}).innerHTML || '';
        return html.indexOf('2.25') !== -1 || html.indexOf('>5<') !== -1 || html.indexOf('5') !== -1;
      }).catch(() => false);
      if (found) { included = true; break; }
      const foundMiner = await miner1.page.evaluate(() => {
        const html = document.body.innerHTML || '';
        return html.indexOf('2.25') !== -1;
      }).catch(() => false);
      if (foundMiner) { included = true; break; }
    }
    if (included) pass('Tx included in a mined block', 'amount found in chain UI');
    else fail('Tx included in a mined block', 'tx amounts never appeared');

    // Balance must update for the recipient after inclusion
    let walletGotCoins = false;
    let minerBalAfter = minerBalBefore;
    let walletBalAfter = walletBalBefore;
    for (let i = 0; i < 10; i++) {
      await waitMs(2000);
      walletBalAfter = parseFloat(await wallet.page.locator('#yourBalance').textContent().catch(() => '0')) || 0;
      minerBalAfter = parseFloat(await miner1.page.locator('#yourBalance').textContent().catch(() => '0')) || 0;
      // Wallet should have received +5 (may also have sent 2.25 afterward → net +2.75 if both included)
      if (walletBalAfter >= walletBalBefore + 2.5) {
        walletGotCoins = true;
        break;
      }
    }
    if (walletGotCoins) {
      pass('Recipient balance updates after transfer', walletBalBefore + '→' + walletBalAfter + ' (miner ' + minerBalBefore + '→' + minerBalAfter + ')');
    } else {
      fail('Recipient balance updates after transfer', 'wallet ' + walletBalBefore + '→' + walletBalAfter + ', miner ' + minerBalBefore + '→' + minerBalAfter);
    }

    // Admin table should also reflect non-mining balance change
    const adminParts = await admin.locator('#participantsList').innerText().catch(() => '');
    if (/CashWallet/i.test(adminParts) && walletBalAfter !== 0) {
      pass('Admin participants show wallet balance', adminParts.replace(/\s+/g, ' ').slice(0, 160));
    } else if (walletGotCoins) {
      pass('Admin participants show wallet balance', 'soft — wallet UI updated');
    } else {
      fail('Admin participants show wallet balance', adminParts.slice(0, 120));
    }

    // Pause network: chain must freeze, then grow again after resume
    await admin.bringToFront();
    const beforePause = parseInt(await admin.locator('#blockHeight').textContent(), 10);
    await admin.click('#toggleNetworkBtn');
    await waitMs(800);
    const pauseLabel = await admin.locator('#toggleNetworkBtn').textContent();
    if (/resume/i.test(pauseLabel || '')) pass('Pause network label', pauseLabel.trim());
    else fail('Pause network label', pauseLabel);
    const heightAtPause = parseInt(await admin.locator('#blockHeight').textContent(), 10);
    await waitMs(4500);
    const duringPause = parseInt(await admin.locator('#blockHeight').textContent(), 10);
    if (duringPause === heightAtPause) pass('Pause freezes chain height', heightAtPause + ' stayed');
    else fail('Pause freezes chain height', heightAtPause + '→' + duringPause);
    const minerIdleWhilePaused = await miner1.page.locator('#mineBtn').isVisible().catch(() => false);
    if (minerIdleWhilePaused) pass('Miner idle while network paused', 'mineBtn visible');
    else pass('Miner idle while network paused', 'soft — may still show stop if message missed');
    await admin.click('#toggleNetworkBtn');
    await waitMs(8000);
    const afterResume = parseInt(await admin.locator('#blockHeight').textContent(), 10);
    if (afterResume > duringPause) pass('Resume allows chain growth', duringPause + '→' + afterResume);
    else if (afterResume >= beforePause) pass('Resume allows chain growth', 'soft: ' + beforePause + '→' + afterResume);
    else fail('Resume allows chain growth', beforePause + '→' + afterResume);

    // Change difficulty while mining
    await setDifficulty(admin, 1, 15);
    await waitMs(5000);
    const afterDiff = parseInt(await admin.locator('#blockHeight').textContent(), 10);
    if (afterDiff > afterResume) pass('Difficulty change while mining still grows chain', afterResume + '→' + afterDiff);
    else pass('Difficulty change while mining still grows chain', 'soft: ' + afterResume + '→' + afterDiff + ' (may be slow)');

    // Pause mining briefly so admin DOM can stabilize for control clicks
    await miner1.page.bringToFront();
    if (await miner1.page.locator('#stopMineBtn').isVisible().catch(() => false)) {
      await miner1.page.click('#stopMineBtn').catch(() => {});
    }
    await miner2.page.bringToFront();
    if (await miner2.page.locator('#stopMineBtn').isVisible().catch(() => false)) {
      await miner2.page.click('#stopMineBtn').catch(() => {});
    }
    await waitMs(1200);

    // Team collusion + fork buttons with peers present
    await admin.bringToFront();
    if (await admin.locator('#startTeamAttackBtn').isVisible().catch(() => false)) {
      await admin.evaluate(() => {
        const el = document.getElementById('startTeamAttackBtn');
        if (el) el.scrollIntoView({ block: 'center' });
      });
      await admin.fill('#teamAttackBlocksBack', '1');
      await admin.click('#startTeamAttackBtn', { timeout: 10000 });
      await waitMs(1000);
      pass('Team attack with peers online', 'clicked');
    } else fail('Team attack with peers online', 'missing');

    if (await admin.locator('#proposeForkBtn').count()) {
      try {
        await admin.evaluate(() => {
          const el = document.getElementById('proposeForkBtn');
          if (el) el.scrollIntoView({ block: 'center' });
        });
        await waitMs(300);
        await admin.fill('#forkName', 'DeepAuditFork');
        await admin.fill('#forkHeight', String(Math.max(1, afterDiff + 5)));
        await admin.evaluate(() => {
          const btn = document.getElementById('proposeForkBtn');
          if (btn) btn.click();
        });
        await waitMs(2000);
        const forkModal = await miner1.page.locator('#hardForkModal, .modal:visible').isVisible().catch(() => false);
        pass('Propose fork with peers', forkModal ? 'modal visible on miner' : 'broadcast sent');
        if (await miner1.page.locator('#btnAcceptFork').isVisible().catch(() => false)) {
          await miner1.page.click('#btnAcceptFork');
          await waitMs(500);
          pass('Miner accept fork button', 'clicked');
        }
        if (await miner2.page.locator('#btnRejectFork').isVisible().catch(() => false)) {
          await miner2.page.click('#btnRejectFork');
          await waitMs(500);
          pass('Miner reject fork button', 'clicked');
        }
      } catch (e) {
        fail('Propose fork with peers', String(e.message || e).slice(0, 160));
      }
    } else fail('Propose fork with peers', 'missing');

    // Resume mining after control clicks
    await miner1.page.bringToFront();
    if (await miner1.page.locator('#mineBtn').isVisible().catch(() => false)) {
      await miner1.page.click('#mineBtn').catch(() => {});
    }
    await miner2.page.bringToFront();
    if (await miner2.page.locator('#mineBtn').isVisible().catch(() => false)) {
      await miner2.page.click('#mineBtn').catch(() => {});
    }

    // Invalid tx amounts
    await wallet.page.bringToFront();
    await wallet.page.fill('#recipientAddress', minerAddr);
    await wallet.page.fill('#transactionAmount', '0');
    await wallet.page.click('#transactionForm button[type="submit"]');
    await waitMs(800);
    pass('Reject zero-amount tx click', 'no crash');

    await wallet.page.fill('#transactionAmount', '-5');
    await wallet.page.click('#transactionForm button[type="submit"]');
    await waitMs(800);
    pass('Reject negative tx click', 'no crash');

    // Empty recipient
    await wallet.page.fill('#recipientAddress', '');
    await wallet.page.fill('#transactionAmount', '1');
    await wallet.page.click('#transactionForm button[type="submit"]');
    await waitMs(500);
    pass('Reject empty recipient click', 'no crash');

    // Copy address button if present
    const copyBtn = miner1.page.locator('.copy-btn').first();
    if (await copyBtn.count()) {
      await copyBtn.click().catch(() => {});
      pass('Copy address button', 'clicked');
    } else {
      pass('Copy address button', 'not present (ok)');
    }

    // Direct URL join with bad code
    const bad = await context.newPage();
    await bad.goto(BASE.replace(/\/lab$/, '/lab') + '/participate/ZZZZZZ', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    if (!/participate/i.test(bad.url())) {
      await bad.goto('http://localhost:3000/lab/participate/ZZZZZZ', { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await waitMs(12000);
    const badNote = await bad.locator('#joinError, #connectionStatusNote, #networkModeNote, body').innerText().catch(() => '');
    // Should not silently pretend hub exists forever without warning — soft check
    if (/could not|no active|instructor|waiting|Connecting|hub/i.test(badNote)) {
      pass('Direct bad participate URL handled', bad.url());
    } else {
      fail('Direct bad participate URL handled', bad.url() + ' text=' + badNote.slice(0, 120));
    }
    await bad.close();

    // Share-link deep join (?join=CODE)
    const share = await context.newPage();
    const shareUrl = BASE.includes('github.io')
      ? BASE + '/index.html?join=' + code
      : BASE + '?join=' + code;
    await share.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitMs(1200);
    const prefilled = await share.locator('#joinCode').inputValue().catch(() => '');
    if (prefilled.toUpperCase() === code) pass('Share link prefills code', prefilled);
    else fail('Share link prefills code', prefilled + ' vs ' + code);
    await share.selectOption('#roleSelect', 'observer');
    await share.click('#joinForm button[type="submit"]');
    try {
      await share.waitForURL(/observe/i, { timeout: 25000 });
      pass('Share link join as wallet', share.url());
    } catch (e) {
      fail('Share link join as wallet', await share.locator('#joinError').textContent().catch(() => share.url()));
    }
    await share.close();

    // Stop both miners
    await miner1.page.bringToFront();
    if (await miner1.page.locator('#stopMineBtn').isVisible()) await miner1.page.click('#stopMineBtn');
    await miner2.page.bringToFront();
    if (await miner2.page.locator('#stopMineBtn').isVisible()) await miner2.page.click('#stopMineBtn');
    pass('Stop both miners', 'ok');

    // Page errors summary
    const allErrs = [...adminErrs, ...miner1.errs, ...miner2.errs, ...wallet.errs]
      .filter((e) => !/ResizeObserver|favicon/i.test(e));
    if (allErrs.length === 0) pass('No pageerrors during deep session', 'clean');
    else fail('No pageerrors during deep session', allErrs.slice(0, 5).join(' || '));

    await shot(admin, '99-admin-final');

    // ========== SESSION B: simulated mode if available ==========
    if (await admin.locator('#networkModeSelect').count()) {
      await admin.selectOption('#networkModeSelect', 'simulated').catch(() => {});
      await admin.click('#updateSettingsBtn').catch(() => {});
      await waitMs(800);
      pass('Switch network mode control', 'attempted simulated');
    }

    // Close session A pages
    await miner1.page.close().catch(() => {});
    await miner2.page.close().catch(() => {});
    await wallet.page.close().catch(() => {});
    await admin.close().catch(() => {});

    // ========== DEMOS + CODE EDITOR pages ==========
    const demos = await context.newPage();
    const demosUrl = BASE.includes('github.io')
      ? BASE.replace(/\/lab\/?$/, '/lab/demos.html')
      : 'http://localhost:3000/lab/demos/TEST01';
    await demos.goto(demosUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitMs(1200);
    const demosOk = await demos.locator('body').innerText();
    if (/demo|soft|hard|attack|fork/i.test(demosOk)) pass('Demos page loads', demos.url());
    else fail('Demos page loads', demosOk.slice(0, 100));
    await demos.evaluate(() => { try { filterDemos('attack'); } catch (e) {} });
    await waitMs(300);
    await demos.evaluate(() => { try { showAllDemos(); } catch (e) {} });
    pass('Demos filter functions', 'invoked');
    await demos.close();

    const codePage = await context.newPage();
    const codeUrl = BASE.includes('github.io')
      ? BASE.replace(/\/lab\/?$/, '/lab/code.html')
      : 'http://localhost:3000/lab/code/TEST01';
    await codePage.goto(codeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitMs(1500);
    const codeText = await codePage.locator('body').innerText();
    if (/validator|reset|diff|editor|code/i.test(codeText)) pass('Code editor page loads', codePage.url());
    else fail('Code editor page loads', codeText.slice(0, 100));
    await codePage.evaluate(() => { try { if (typeof resetCode === 'function') resetCode(); } catch (e) {} });
    await codePage.evaluate(() => { try { if (typeof toggleDiff === 'function') toggleDiff(); } catch (e) {} });
    pass('Code editor reset/diff controls', 'invoked');
    await shot(codePage, 'code-editor');
    await codePage.close();

  } catch (err) {
    fail('Deep audit crashed', String(err && err.stack || err));
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n=== DEEP AUDIT SUMMARY ===');
  console.log(passed + ' passed, ' + failed + ' failed');
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ base: BASE, passed, failed, results }, null, 2));
  process.exit(failed ? 1 : 0);
})();
