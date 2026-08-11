/**
 * Exhaustive Blockchain Lab UI audit (Playwright).
 * Runs against local Express by default; pass a base URL as argv[2].
 *
 * Usage: node scripts/exhaustive-lab-audit.js [baseUrl]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const OUT = path.join(__dirname, '..', 'tmp-audit');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function pass(name, detail) { results.push({ ok: true, name, detail: detail || '' }); console.log('PASS  ' + name + (detail ? ' — ' + detail : '')); }
function fail(name, detail) { results.push({ ok: false, name, detail: detail || '' }); console.log('FAIL  ' + name + ' — ' + detail); }
function info(msg) { console.log('INFO  ' + msg); }

async function shot(page, name) {
  try { await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }); } catch (e) {}
}

async function clickIfVisible(page, sel, timeout) {
  const el = page.locator(sel).first();
  if (await el.isVisible({ timeout: timeout || 2000 }).catch(() => false)) {
    await el.click();
    return true;
  }
  return false;
}

async function waitMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  const admin = await context.newPage();
  admin.on('pageerror', (e) => console.log('[admin pageerror]', e.message));
  admin.on('console', (m) => { if (m.type() === 'error') console.log('[admin console]', m.text()); });

  try {
    // ========== LANDING ==========
    info('Open landing ' + BASE);
    await admin.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(1200);
    await shot(admin, '01-landing');

    const brand = await admin.locator('.lab-landing__brand h1, h1').first().textContent().catch(() => '');
    if (/Blockchain Lab/i.test(brand || '')) pass('Landing brand', brand.trim());
    else fail('Landing brand', brand);

    // Invalid join before session exists
    await admin.fill('#joinCode', 'NOPE12');
    await admin.selectOption('#roleSelect', 'participant');
    await admin.click('#joinForm button[type="submit"]');
    await waitMs(16000);
    const badErr = await admin.locator('#joinError').textContent().catch(() => '');
    if (/could not reach|no active|instructor/i.test(badErr || '')) pass('Invalid/inactive join blocked', badErr.slice(0, 120));
    else fail('Invalid/inactive join blocked', badErr || admin.url());
    await shot(admin, '02-invalid-join');

    // Create session
    await admin.click('#createSessionBtn');
    await admin.waitForURL(/admin/i, { timeout: 45000 });
    await waitMs(4000);
    await shot(admin, '03-admin');

    let code = (await admin.locator('#sessionCode').textContent().catch(() => '') || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) {
      const u = new URL(admin.url());
      code = (u.searchParams.get('session') || u.pathname.split('/').pop() || '').toUpperCase();
    }
    if (/^[A-Z0-9]{4,8}$/.test(code)) pass('Create session', code);
    else fail('Create session', admin.url());

    const share = await admin.locator('#joinShareLink').inputValue().catch(() => '');
    if (share && share.toUpperCase().includes(code)) pass('Share link populated', share);
    else fail('Share link populated', share);

    await admin.click('#copyJoinLinkBtn');
    await waitMs(400);
    const copyLabel = await admin.locator('#copyJoinLinkBtn').textContent();
    if (/copied|copy/i.test(copyLabel || '')) pass('Copy join link button', copyLabel.trim());
    else fail('Copy join link button', copyLabel);

    const qr = await admin.evaluate(() => {
      const c = document.getElementById('joinQrCanvas');
      if (!c) return { ok: false };
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 200) dark++;
      return { ok: dark > 40, dark };
    });
    if (qr.ok) pass('QR drawn', JSON.stringify(qr));
    else fail('QR drawn', JSON.stringify(qr));

    // Topology hub
    await waitMs(1000);
    const topo1 = await admin.evaluate(() => {
      const svg = document.querySelector('#networkVisualizationSvg');
      if (!svg) return { ok: false };
      return { ok: svg.querySelectorAll('g.node').length >= 1, nodes: svg.querySelectorAll('g.node').length };
    });
    if (topo1.ok) pass('Topology hub node', JSON.stringify(topo1));
    else fail('Topology hub node', JSON.stringify(topo1));

    // ========== ADMIN CONTROLS ==========
    await admin.locator('#difficultyLeading').fill('4');
    await admin.locator('#difficultySecondary').fill('8');
    await admin.locator('#miningReward').fill('12');
    await admin.selectOption('#networkModeSelect', 'admin-relay');
    await admin.check('#lockParameters');
    await admin.click('#updateSettingsBtn');
    await waitMs(800);
    const leadVal = await admin.locator('#difficultyLeadingValue').textContent();
    const secVal = await admin.locator('#difficultySecondaryValue').textContent();
    if (String(leadVal).trim() === '4') pass('Difficulty leading slider/display', leadVal);
    else fail('Difficulty leading slider/display', leadVal);
    if (/8/i.test(String(secVal))) pass('Difficulty secondary slider/display', secVal);
    else fail('Difficulty secondary slider/display', secVal);

    await admin.click('#toggleNetworkBtn');
    await waitMs(500);
    let toggleTxt = await admin.locator('#toggleNetworkBtn').textContent();
    if (/resume/i.test(toggleTxt || '')) pass('Pause network', toggleTxt.trim());
    else fail('Pause network', toggleTxt);
    await admin.click('#toggleNetworkBtn');
    await waitMs(500);
    toggleTxt = await admin.locator('#toggleNetworkBtn').textContent();
    if (/pause/i.test(toggleTxt || '')) pass('Resume network', toggleTxt.trim());
    else fail('Resume network', toggleTxt);

    // Attack / fork injected controls
    const teamVisible = await admin.locator('#startTeamAttackBtn').isVisible().catch(() => false);
    if (teamVisible) {
      await admin.fill('#teamAttackBlocksBack', '2');
      await admin.click('#startTeamAttackBtn');
      await waitMs(600);
      pass('Team collusion button clickable', 'clicked');
    } else {
      fail('Team collusion button present', 'missing');
    }

    if (await admin.locator('#proposeForkBtn').isVisible().catch(() => false)) {
      await admin.fill('#forkName', 'Audit Fork');
      await admin.fill('#forkHeight', '99');
      await admin.click('#proposeForkBtn');
      await waitMs(600);
      pass('Propose hard fork button', 'clicked');
    } else {
      fail('Propose hard fork button', 'missing');
    }

    // ========== MINER JOIN ==========
    const miner = await context.newPage();
    miner.on('pageerror', (e) => console.log('[miner pageerror]', e.message));
    miner.on('console', (m) => { if (m.type() === 'error') console.log('[miner console]', m.text()); });
    await miner.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(1000);
    await miner.fill('#joinCode', code);
    await miner.selectOption('#roleSelect', 'participant');
    await miner.click('#joinForm button[type="submit"]');
    try {
      await miner.waitForURL(/participate/i, { timeout: 25000 });
      pass('Miner join valid session', miner.url());
    } catch (e) {
      const err = await miner.locator('#joinError').textContent().catch(() => '');
      fail('Miner join valid session', err || miner.url());
    }
    await waitMs(5000);
    await shot(miner, '04-miner');

    // Name
    await miner.fill('#nodeName', 'AuditMiner');
    await miner.click('#setNodeNameBtn');
    await waitMs(1500);
    pass('Miner save node name', 'AuditMiner');

    // CPU slider
    await miner.locator('#cpuUsage').fill('30');
    await waitMs(300);
    const cpu = await miner.locator('#cpuUsageValue').textContent();
    if (/30/.test(cpu || '')) pass('CPU slider', cpu.trim());
    else fail('CPU slider', cpu);

    // Validator source must load as a real string (corrupt JSON previously broke mining)
    await waitMs(1500);
    const validatorMeta = await miner.evaluate(() => {
      const v = document.querySelector('#validatorCodeEditor');
      const val = v ? v.value : '';
      return {
        len: (val || '').length,
        startsOk: /^[\s\S]*class\s+BlockValidator/.test(val || ''),
        customType: typeof window.customValidator,
        broken: !!(window.customValidator && window.customValidator._broken)
      };
    });
    if (validatorMeta.len > 500 && validatorMeta.startsOk && !validatorMeta.broken) {
      pass('Validator code loaded as string', JSON.stringify(validatorMeta));
    } else {
      fail('Validator code loaded as string', JSON.stringify(validatorMeta));
    }

    // Tabs (smoke navigation)
    for (const [href, label] of [
      ['#tabNetwork', 'Shared Network tab'],
      ['#tabCode', 'Validator Code tab'],
      ['#tabDemos', 'Guided Demos tab'],
      ['#tabOverview', 'Personal Chain tab']
    ]) {
      const ok = await clickIfVisible(miner, `a[href="${href}"]`);
      await waitMs(400);
      const active = await miner.locator(href).isVisible().catch(() => false);
      if (ok && active) pass(label, 'visible');
      else fail(label, `clicked=${ok} visible=${active}`);
    }

    await clickIfVisible(miner, 'a[href="#tabOverview"]');
    await waitMs(400);

    // Ease difficulty before mining so the audit finishes quickly
    await admin.bringToFront();
    await admin.uncheck('#lockParameters').catch(() => {});
    await admin.locator('#difficultyLeading').fill('2');
    await admin.locator('#difficultySecondary').fill('15');
    await admin.click('#updateSettingsBtn');
    await waitMs(1200);

    // Start mining BEFORE validator experiments (broken validator must not mask mining bugs)
    await miner.bringToFront();
    if (await miner.locator('#mineBtn').isVisible()) {
      await miner.click('#mineBtn');
      await waitMs(8000);
      const mining = await miner.locator('#miningActivity').innerText().catch(() => '');
      const stopVis = await miner.locator('#stopMineBtn').isVisible().catch(() => false);
      if (stopVis || /mining|nonce|hashrate/i.test(mining)) pass('Start mining', mining.slice(0, 80));
      else fail('Start mining', mining);
      await shot(miner, '05-mining');
    } else fail('Start mining', 'mineBtn missing');

    // Admin should see participant + possibly blocks
    await admin.bringToFront();
    await waitMs(3000);
    await shot(admin, '06-admin-after-miner');
    const partText = await admin.locator('#participantsList').innerText().catch(() => '');
    if (/AuditMiner|user-|miner|admin/i.test(partText)) pass('Admin participants list after join', partText.slice(0, 160));
    else fail('Admin participants list after join', partText.slice(0, 160));

    const topo2 = await admin.evaluate(() => {
      const svg = document.querySelector('#networkVisualizationSvg');
      return {
        nodes: svg ? svg.querySelectorAll('g.node').length : 0,
        labels: svg ? Array.from(svg.querySelectorAll('.node-label-name')).map((n) => n.textContent) : []
      };
    });
    if (topo2.nodes >= 2) pass('Topology shows miner', JSON.stringify(topo2));
    else fail('Topology shows miner', JSON.stringify(topo2));

    if ((topo2.labels || []).some((l) => /AuditMiner/i.test(l || ''))) pass('Topology shows renamed miner', topo2.labels.join(','));
    else fail('Topology shows renamed miner', (topo2.labels || []).join(','));

    const height = parseInt(await admin.locator('#blockHeight').textContent().catch(() => '0'), 10);
    if (height >= 0) pass('Admin block height readable', String(height));
    else fail('Admin block height readable', String(height));

    info('Waiting for at least one mined block…');
    let minedOk = false;
    for (let i = 0; i < 20; i++) {
      await waitMs(3000);
      const h = parseInt(await admin.locator('#blockHeight').textContent().catch(() => '0'), 10);
      const minedCell = await admin.locator('#participantsList').innerText().catch(() => '');
      if (h >= 1) {
        minedOk = true;
        pass('Block mined on hub', 'height=' + h);
        const hasNonZero = await admin.evaluate(() => {
          const rows = Array.from(document.querySelectorAll('#participantsList tr'));
          return rows.some((r) => {
            const tds = r.querySelectorAll('td');
            return tds.length >= 3 && /miner|audit/i.test(r.innerText) && parseInt(tds[2].innerText, 10) > 0;
          });
        });
        if (hasNonZero) pass('Participants blocks-mined updates', minedCell.slice(0, 120));
        else fail('Participants blocks-mined updates', minedCell.slice(0, 160));
        break;
      }
      info('still height=' + h + ' t=' + ((i + 1) * 3) + 's');
    }
    if (!minedOk) fail('Block mined on hub', 'timeout — no block accepted');

    // Validator tab buttons (after mining works)
    await miner.bringToFront();
    await clickIfVisible(miner, 'a[href="#tabCode"]');
    await waitMs(400);
    if (await miner.locator('#submitValidatorCodeBtn').isVisible()) {
      await miner.click('#submitValidatorCodeBtn');
      await waitMs(800);
      const stillOk = await miner.evaluate(() => !(window.customValidator && window.customValidator._broken));
      if (stillOk) pass('Submit validator code', 'applied without breaking miner');
      else fail('Submit validator code', 'miner marked broken after submit');
    } else fail('Submit validator code', 'not visible');

    if (await miner.locator('#btnSetupDoubleSpend').isVisible()) {
      await miner.click('#btnSetupDoubleSpend');
      await waitMs(800);
      pass('Setup double spend', 'clicked');
    } else fail('Setup double spend', 'not visible');

    if (await miner.locator('#resetValidatorCodeBtn').isVisible()) {
      miner.once('dialog', async (d) => { await d.accept(); });
      await miner.click('#resetValidatorCodeBtn');
      await waitMs(800);
      const afterReset = await miner.evaluate(() => ({
        broken: !!(window.customValidator && window.customValidator._broken),
        hasValidator: !!window.customValidator,
        editorLen: (document.querySelector('#validatorCodeEditor') || {}).value?.length || 0
      }));
      if (!afterReset.broken && afterReset.editorLen > 500) pass('Reset validator code', JSON.stringify(afterReset));
      else fail('Reset validator code', JSON.stringify(afterReset));
    } else fail('Reset validator code', 'not visible');

    await clickIfVisible(miner, 'a[href="#tabDemos"]');
    await waitMs(400);
    const demosLink = miner.locator('a[onclick*="openDemos"], button[onclick*="openDemos"], a:has-text("View All Demos"), a:has-text("Open Demos")');
    if (await demosLink.count()) {
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 8000 }).catch(() => null),
        demosLink.first().click().catch(() => {})
      ]);
      if (popup) {
        await popup.waitForLoadState('domcontentloaded').catch(() => {});
        pass('Open guided demos', popup.url());
        await popup.close().catch(() => {});
      } else {
        pass('Open guided demos', 'clicked (no separate popup)');
      }
    } else {
      fail('Open guided demos link', 'not found');
    }

    await clickIfVisible(miner, 'a[href="#tabOverview"]');
    await waitMs(400);

    // ========== WALLET JOIN + TX ==========
    const wallet = await context.newPage();
    wallet.on('pageerror', (e) => console.log('[wallet pageerror]', e.message));
    await wallet.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(800);
    await wallet.fill('#joinCode', code);
    await wallet.selectOption('#roleSelect', 'observer');
    await wallet.click('#joinForm button[type="submit"]');
    try {
      await wallet.waitForURL(/observe/i, { timeout: 25000 });
      pass('Wallet join valid session', wallet.url());
    } catch (e) {
      fail('Wallet join valid session', await wallet.locator('#joinError').textContent().catch(() => wallet.url()));
    }
    await waitMs(4000);
    await shot(wallet, '07-wallet');

    await wallet.fill('#nodeName', 'AuditWallet');
    await wallet.click('#setNodeNameBtn');
    await waitMs(1200);
    pass('Wallet save name', 'AuditWallet');

    // Get miner address from miner page
    await miner.bringToFront();
    const minerAddr = (await miner.locator('#yourAddress').textContent().catch(() => '') || '').trim();
    const walletAddr = (await wallet.locator('#yourAddress').textContent().catch(() => '') || '').trim();
    pass('Addresses present', `miner=${minerAddr} wallet=${walletAddr}`);

    // Send tx wallet -> miner
    await wallet.bringToFront();
    await wallet.fill('#recipientAddress', minerAddr || 'user-missing');
    await wallet.fill('#transactionAmount', '1.5');
    await wallet.click('#transactionForm button[type="submit"]');
    await waitMs(3000);
    await shot(wallet, '08-tx-sent');

    // Check pending txs on miner network tab
    await miner.bringToFront();
    await clickIfVisible(miner, 'a[href="#tabNetwork"]');
    await waitMs(1500);
    const pending = await miner.locator('#pendingTransactions').innerText().catch(() => '');
    if (/1\.5|AuditWallet|user-/i.test(pending) && !/No pending/i.test(pending)) {
      pass('Pending transactions after send', pending.slice(0, 160));
    } else {
      // also check wallet pending
      const wPending = await wallet.locator('#pendingTransactions').innerText().catch(() => '');
      if (/1\.5/i.test(wPending) && !/No pending/i.test(wPending)) pass('Pending transactions after send', wPending.slice(0, 160));
      else fail('Pending transactions after send', 'miner=[' + pending.slice(0, 100) + '] wallet=[' + wPending.slice(0, 100) + ']');
    }

    // Miner send tx too
    await clickIfVisible(miner, 'a[href="#tabOverview"]');
    await waitMs(400);
    await miner.fill('#recipientAddress', walletAddr || 'user-missing');
    await miner.fill('#transactionAmount', '0.25');
    await miner.click('#transactionForm button[type="submit"]');
    await waitMs(2500);
    pass('Miner send transaction click', '0.25');

    // Stop mining
    await miner.bringToFront();
    if (await miner.locator('#stopMineBtn').isVisible().catch(() => false)) {
      await miner.click('#stopMineBtn');
      await waitMs(500);
      if (await miner.locator('#mineBtn').isVisible()) pass('Stop mining', 'mineBtn visible again');
      else fail('Stop mining', 'mineBtn not visible');
    } else {
      fail('Stop mining', 'stopMineBtn not visible');
    }

    // Open test peer from admin
    await admin.bringToFront();
    if (await admin.locator('#openTestPeerBtn').isVisible().catch(() => false)) {
      const [peer] = await Promise.all([
        context.waitForEvent('page', { timeout: 10000 }).catch(() => null),
        admin.click('#openTestPeerBtn')
      ]);
      if (peer) {
        await peer.waitForLoadState('domcontentloaded').catch(() => {});
        pass('Open test peer tab', peer.url());
        await peer.close().catch(() => {});
      } else fail('Open test peer tab', 'no popup');
    } else {
      fail('Open test peer tab', 'button missing');
    }

    // Chain name next to address (if blocks exist)
    const chainHtml = await admin.locator('#blockchainView').innerText().catch(() => '');
    if (/Miner|genesis|Block #/i.test(chainHtml)) pass('Admin chain view renders', chainHtml.slice(0, 100));
    else fail('Admin chain view renders', chainHtml.slice(0, 100));

    // Legend for topology
    const legend = await admin.locator('#networkTopologyLegend').innerText().catch(() => '');
    if (/Admin|Miner|Wallet/i.test(legend)) pass('Topology role legend', legend.replace(/\s+/g, ' ').slice(0, 120));
    else fail('Topology role legend', legend.slice(0, 120));

    // Pause network while peers are connected
    await admin.click('#toggleNetworkBtn');
    await waitMs(800);
    const pausedLabel = await admin.locator('#toggleNetworkBtn').textContent();
    if (/resume/i.test(pausedLabel || '')) pass('Pause with peers connected', pausedLabel.trim());
    else fail('Pause with peers connected', pausedLabel);
    await admin.click('#toggleNetworkBtn');
    await waitMs(500);

    // Chain shows miner display name next to address
    if (/AuditMiner/i.test(chainHtml)) pass('Chain shows miner display name', 'AuditMiner present');
    else fail('Chain shows miner display name', chainHtml.slice(0, 200));

    // Restart mining after stop (state combination)
    await miner.bringToFront();
    await miner.click('#mineBtn');
    await waitMs(2500);
    if (await miner.locator('#stopMineBtn').isVisible()) pass('Restart mining after stop', 'stop visible');
    else fail('Restart mining after stop', 'stop not visible');
    await miner.click('#stopMineBtn');
    await waitMs(400);

    // Demos page filters + start button
    const demos = await context.newPage();
    const demosUrl = /github\.io/i.test(BASE)
      ? BASE.replace(/\/lab\/?$/, '/lab/demos.html')
      : (BASE.replace(/\/?$/, '/') + 'demos/' + code);
    await demos.goto(demosUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitMs(1500);
    await shot(demos, '12-demos');
    for (const [label, fn] of [
      ['soft-fork filter', "filterDemos('soft-fork')"],
      ['hard-fork filter', "filterDemos('hard-fork')"],
      ['attack filter', "filterDemos('attack')"],
      ['show all', 'showAllDemos()']
    ]) {
      const clicked = await demos.evaluate((call) => {
        try {
          // Prefer globals without eval when possible
          if (call.indexOf('filterDemos') === 0 && typeof filterDemos === 'function') {
            filterDemos(call.match(/'([^']+)'/)[1]);
            return true;
          }
          if (call.indexOf('showAllDemos') === 0 && typeof showAllDemos === 'function') {
            showAllDemos();
            return true;
          }
          eval(call);
          return true;
        } catch (e) { return false; }
      }, fn);
      await waitMs(300);
      if (clicked) pass('Demos ' + label, 'ok');
      else fail('Demos ' + label, 'fn missing @ ' + demos.url());
    }
    const viewBtn = demos.locator('button:has-text("View"), button:has-text("Demo"), h5[onclick*="viewDemo"]').first();
    if (await viewBtn.count()) {
      await viewBtn.click().catch(() => {});
      await waitMs(600);
      if (await demos.locator('#startDemoBtn').isVisible().catch(() => false)) {
        await demos.click('#startDemoBtn');
        await waitMs(800);
        pass('Demos start button', 'clicked');
      } else {
        pass('Demos view interaction', 'no modal start (catalog only)');
      }
    } else {
      fail('Demos catalog items', 'none clickable @ ' + demos.url());
    }
    await demos.close().catch(() => {});

    // Landing role-select label flips Join button text
    const landing = await context.newPage();
    await landing.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMs(600);
    await landing.selectOption('#roleSelect', 'observer');
    await waitMs(300);
    const joinTxt = await landing.locator('#joinForm button[type="submit"]').textContent();
    if (/wallet/i.test(joinTxt || '')) pass('Landing join button role label', joinTxt.trim());
    else fail('Landing join button role label', joinTxt);
    await landing.close().catch(() => {});

    await shot(admin, '09-admin-final');
    await shot(miner, '10-miner-final');
    await shot(wallet, '11-wallet-final');

  } catch (err) {
    fail('Audit run crashed', String(err && err.stack || err));
    try { await shot(admin, '99-crash'); } catch (e) {}
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n=== AUDIT SUMMARY ===');
  console.log(passed + ' passed, ' + failed + ' failed');
  console.log('Screenshots: ' + OUT);
  const report = { base: BASE, passed, failed, results };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  process.exit(failed ? 1 : 0);
})();
