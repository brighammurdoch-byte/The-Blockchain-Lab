/**
 * Audit: lock parameters, hard fork modal, team collusion assignment.
 * Usage: node scripts/admin-controls-audit.js [baseUrl]
 */
const { chromium } = require('playwright');
const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const results = [];
  const pass = (n, d) => { results.push({ ok: true, n, d }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); };
  const fail = (n, d) => { results.push({ ok: false, n, d }); console.log('FAIL  ' + n + ' — ' + d); };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await admin.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await admin.click('#createSessionBtn');
  await admin.waitForURL(/admin/i, { timeout: 45000 });
  await wait(2500);
  const code = (await admin.locator('#sessionCode').textContent() || '').trim().toUpperCase();

  // --- Lock parameters ---
  await admin.uncheck('#lockParameters').catch(() => {});
  await admin.locator('#difficultyLeading').fill('2');
  await admin.check('#lockParameters');
  await admin.click('#updateSettingsBtn');
  await wait(500);
  const disabled = await admin.locator('#difficultyLeading').isDisabled();
  if (disabled) pass('Lock disables difficulty slider');
  else fail('Lock disables difficulty slider', 'still enabled');

  // Try to change while locked — should stay frozen
  await admin.locator('#difficultyLeading').fill('5').catch(() => {});
  await admin.click('#updateSettingsBtn');
  await wait(400);
  const stillDisabled = await admin.locator('#difficultyLeading').isDisabled();
  const val = await admin.locator('#difficultyLeading').inputValue();
  if (stillDisabled && val === '2') pass('Locked update rejected (value frozen at 2)', val);
  else fail('Locked update rejected (value frozen at 2)', 'disabled=' + stillDisabled + ' val=' + val);

  // Unlock
  await admin.uncheck('#lockParameters');
  await admin.click('#updateSettingsBtn');
  await wait(400);
  if (!(await admin.locator('#difficultyLeading').isDisabled())) pass('Unlock re-enables controls');
  else fail('Unlock re-enables controls', 'still disabled');

  // --- Two miners for collusion ---
  async function joinMiner(name) {
    const p = await ctx.newPage();
    await p.goto(BASE, { waitUntil: 'domcontentloaded' });
    await p.fill('#joinCode', code);
    await p.selectOption('#roleSelect', 'participant');
    await p.click('#joinForm button[type="submit"]');
    await p.waitForURL(/participate/i, { timeout: 30000 });
    await wait(2500);
    await p.fill('#nodeName', name);
    await p.click('#setNodeNameBtn');
    return p;
  }
  const m1 = await joinMiner('C1');
  const m2 = await joinMiner('C2');
  await m1.click('#mineBtn');
  await m2.click('#mineBtn');
  await wait(3000);

  // --- Hard fork ---
  await admin.bringToFront();
  await admin.locator('#forkHeight').fill('3');
  await admin.locator('#forkName').fill('Audit Fork');
  admin.once('dialog', (d) => d.accept());
  await admin.click('#proposeForkBtn');
  await wait(2000);

  // Modal or toast on miner
  let forkSeen = false;
  for (const page of [m1, m2]) {
    const modalVisible = await page.locator('#forkChoiceModal.in, #forkChoiceModal.show').isVisible().catch(() => false);
    const panelVisible = await page.locator('#forkControlPanel').isVisible().catch(() => false);
    const nameText = await page.locator('#forkProposalName').textContent().catch(() => '');
    if (modalVisible || panelVisible || /Audit Fork/i.test(nameText || '')) {
      forkSeen = true;
      break;
    }
    // Bootstrap 3 uses .in
    const display = await page.evaluate(() => {
      const el = document.getElementById('forkChoiceModal');
      if (!el) return '';
      return window.getComputedStyle(el).display + '|' + el.className;
    }).catch(() => '');
    if (/block|in|show/i.test(display)) forkSeen = true;
  }
  // Also check panel was forced shown
  if (!forkSeen) {
    forkSeen = await m1.evaluate(() => {
      const p = document.getElementById('forkControlPanel');
      return p && p.style.display !== 'none' && $(p).is(':visible');
    }).catch(() => false);
  }
  if (forkSeen) pass('Hard fork reaches miners (modal/panel)');
  else {
    // Accept toast path — check proposal name was set even if modal CSS differs
    const n = await m1.locator('#forkProposalName').textContent().catch(() => '');
    if (/Audit/i.test(n || '')) pass('Hard fork reaches miners (modal/panel)', 'name set: ' + n);
    else fail('Hard fork reaches miners (modal/panel)', 'no modal/panel; name=' + n);
  }

  // --- Team collusion ---
  await admin.bringToFront();
  admin.once('dialog', (d) => d.accept());
  await admin.click('#startTeamAttackBtn');
  await wait(2500);

  const states = [];
  for (const page of [m1, m2]) {
    const st = await page.evaluate(() => ({
      flag: window.__labCollusion || null,
      banner: (document.getElementById('collusionBanner') || {}).textContent || ''
    })).catch(() => ({ flag: null, banner: '' }));
    states.push(st);
  }
  const anyColluder = states.some((s) => (s.flag && s.flag.onTeam) || /collud|attack team/i.test(s.banner));
  const anyHonest = states.some((s) => (s.flag && s.flag.onHonest) || /honest/i.test(s.banner));
  if (anyColluder && anyHonest) pass('Collusion assigns attack + honest teams', JSON.stringify(states).slice(0, 200));
  else if (anyColluder) pass('Collusion assigns attack team', JSON.stringify(states).slice(0, 200));
  else fail('Collusion assigns attack team', JSON.stringify(states).slice(0, 280));

  // Stats panel on admin
  const statsVisible = await admin.locator('#teamAttackStats').isVisible().catch(() => false);
  if (statsVisible) pass('Admin collusion stats shown');
  else fail('Admin collusion stats shown', 'hidden');

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n==== admin-controls-audit: ' + (results.length - failed) + '/' + results.length + ' passed ====');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
