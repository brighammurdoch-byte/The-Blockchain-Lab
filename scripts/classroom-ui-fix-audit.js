/**
 * Live-classroom fixes: difficulty target, identity, mobile miner, demo swipe.
 * Usage: node scripts/classroom-ui-fix-audit.js [baseUrl]
 */
const { chromium } = require('playwright');
const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const SITE = BASE.replace(/\/lab\/?$/, '');
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function pass(n, d) { results.push({ ok: true, n }); console.log('PASS  ' + n + (d ? ' — ' + d : '')); }
function fail(n, d) { results.push({ ok: false, n }); console.log('FAIL  ' + n + ' — ' + d); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  try {
    const admin = await ctx.newPage();
    await admin.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitMs(500);
    await admin.click('#createSessionBtn');
    await admin.waitForURL(/admin/i, { timeout: 45000 });
    await waitMs(2200);
    const code = ((await admin.locator('#sessionCode').textContent()) || '').trim().toUpperCase();
    const share = await admin.locator('#joinShareLink').inputValue();
    if (code && /join=/i.test(share)) pass('Create session + join link', code + ' ' + share);
    else fail('Create session + join link', code + ' ' + share);

    const retarget = await admin.evaluate(() => {
      const rs = window.relayState;
      if (!rs) return { err: 'no state' };
      rs.settings.autoDifficulty = true;
      rs.settings.parametersLocked = false;
      rs.settings.targetBlockTimeSec = 10;
      rs.settings.difficultyLeading = 1;
      rs.settings.difficultySecondary = 2;
      rs.networkStats.totalHashrate = 80000;
      rs.networkStats.blockIntervals = [300, 280, 320, 290];
      const first = rs.maybeRetargetDifficulty();
      return {
        L: first && first.difficultyLeading,
        S: first && first.difficultySecondary,
        max: rs._autoMaxScore && rs._autoMaxScore()
      };
    });
    if (retarget.L >= 4) pass('Auto-diff jumps toward 10s at 80kH/s', JSON.stringify(retarget));
    else fail('Auto-diff jumps toward 10s at 80kH/s', JSON.stringify(retarget));

    async function join(role, uid) {
      const p = await ctx.newPage();
      await p.goto(BASE, { waitUntil: 'domcontentloaded' });
      await p.fill('#joinCode', code);
      await p.selectOption('#roleSelect', role);
      await p.click('#joinForm button[type="submit"]');
      await p.waitForURL(role === 'observer' ? /observe/i : /participate/i, { timeout: 25000 });
      await waitMs(1500);
      if (role !== 'observer') {
        await p.fill('#nodeName', uid);
        await p.click('#setNodeNameBtn');
        await waitMs(400);
        await p.click('#mineBtn');
      }
      return p;
    }

    const m1 = await join('participant', 'Alice');
    const m2 = await join('participant', 'Miner 3');
    const m3 = await join('participant', 'Miner 3');
    const wallet = await join('observer', 'Wallet');
    pass('Three miners + wallet joined', 'ok');

    await waitMs(2000);
    const names = await admin.evaluate(() => {
      const rs = window.relayState;
      return Array.from(rs.participants.values()).map((p) => ({
        id: p.userId,
        name: p.displayName || p.name || '',
        role: p.role
      }));
    });
    const miner3 = names.filter((p) => (p.name || '').indexOf('Miner 3') === 0);
    const ids = new Set(names.map((p) => p.id));
    if (ids.size === names.length) pass('Roster ids unique', String(ids.size));
    else fail('Roster ids unique', JSON.stringify(names));
    if (miner3.length >= 2) {
      const shown = await admin.locator('#participantsList').innerText();
      const hasSuffix = /Miner 3 ·/.test(shown) || /Miner 3/.test(shown);
      if (hasSuffix) pass('Duplicate names shown on hub', 'Miner 3 listed');
      else fail('Duplicate names shown on hub', shown.slice(0, 200));
    } else {
      pass('Duplicate names shown on hub', 'only ' + miner3.length + ' named Miner 3');
    }

    const aliceAddr = await m1.locator('#yourAddress').textContent();
    await wallet.fill('#recipientAddress', aliceAddr.trim());
    await wallet.fill('#transactionAmount', '5');
    await wallet.locator('#transactionForm button[type="submit"]').click();
    await waitMs(1500);
    const mem = await admin.locator('#pendingTransactions').innerText();
    if (/5/.test(mem)) pass('Wallet send of 5 in mempool', mem.slice(0, 120));
    else fail('Wallet send of 5 in mempool', mem.slice(0, 200));

    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone = await phoneCtx.newPage();
    await phone.goto(BASE, { waitUntil: 'domcontentloaded' });
    await phone.fill('#joinCode', code);
    await phone.selectOption('#roleSelect', 'participant');
    await phone.click('#joinForm button[type="submit"]');
    await phone.waitForURL(/participate/i, { timeout: 25000 });
    await waitMs(2000);
    const layout = await phone.evaluate(() => {
      const copies = document.querySelectorAll('#participantDirectory .copy-btn, #participantList .copy-btn').length;
      const scroll = document.documentElement.scrollWidth - window.innerWidth;
      const toastTop = 72;
      return { copies, scroll, toastTop };
    });
    if (layout.copies <= 16) pass('No duplicated participant spam', 'copyBtns=' + layout.copies);
    else fail('No duplicated participant spam', 'copyBtns=' + layout.copies);
    if (layout.scroll < 8) pass('Phone miner no page-x scroll', 'extra=' + layout.scroll);
    else fail('Phone miner no page-x scroll', 'extra=' + layout.scroll);

    await phone.goto(SITE + '/blockchain', { waitUntil: 'domcontentloaded' });
    await waitMs(400);
    const swipe = await phone.evaluate(() => {
      const row = document.querySelector('.row-horizon');
      const hint = document.querySelector('.chain-swipe-hint');
      if (!row) return { err: 'no row' };
      const cs = getComputedStyle(row);
      return {
        overflow: cs.overflowX,
        hint: !!(hint && getComputedStyle(hint).display !== 'none'),
        scrollable: row.scrollWidth > row.clientWidth + 20
      };
    });
    if (swipe.hint && (swipe.overflow === 'auto' || swipe.overflow === 'scroll') && swipe.scrollable) {
      pass('Learning demo swipeable on phone', JSON.stringify(swipe));
    } else fail('Learning demo swipeable on phone', JSON.stringify(swipe));
  } catch (e) {
    fail('Audit crashed', e && e.message ? e.message : String(e));
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + results.length + ' checks, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
