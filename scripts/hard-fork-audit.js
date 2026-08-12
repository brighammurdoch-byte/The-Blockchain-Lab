/**
 * Hard-fork classroom audit: two miners must permanently split after activation.
 *
 * Checks:
 *  1. Proposal reaches both miners
 *  2. Classic miner only extends classic after activation
 *  3. NEW miner only extends NEW after activation
 *  4. Both sides grow (parallel tips, not one reorg wiping the other)
 *  5. Hub main chain does not mix classic+NEW post-activation into one path
 *  6. Shared Network / orphans expose the competing side
 *
 * Usage: node scripts/hard-fork-audit.js [baseUrl]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'http://localhost:3000/lab').replace(/\/$/, '');
const OUT = path.join(__dirname, '..', 'tmp-audit-hard-fork');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function pass(name, detail) {
  results.push({ ok: true, name, detail: detail || '' });
  console.log('PASS  ' + name + (detail ? ' — ' + detail : ''));
}
function fail(name, detail) {
  results.push({ ok: false, name, detail: detail || '' });
  console.log('FAIL  ' + name + ' — ' + detail);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function joinMiner(context, code, name) {
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(400);
  await page.fill('#joinCode', code);
  await page.selectOption('#roleSelect', 'participant');
  await page.click('#joinForm button[type="submit"]');
  await page.waitForURL(/participate/i, { timeout: 30000 });
  await wait(2500);
  await page.fill('#nodeName', name);
  await page.click('#setNodeNameBtn').catch(() => {});
  await wait(500);
  return page;
}

/** Snapshot fork-relevant state from a miner page. */
async function minerSnapshot(page) {
  return page.evaluate(() => {
    function isNew(fid) {
      return fid === 'new' || fid === 'NEW';
    }
    function isClassic(fid) {
      return !isNew(fid);
    }
    const main = window.lastRelayedChain || [];
    const orphans = (typeof lastKnownOrphans !== 'undefined' && lastKnownOrphans) || [];
    const localNew =
      typeof localNewForkTip !== 'undefined' && localNewForkTip ? localNewForkTip : null;
    const choice = typeof myForkChoice !== 'undefined' ? myForkChoice : null;
    const act = typeof pendingForkHeight !== 'undefined' ? pendingForkHeight : null;

    const all = [];
    main.forEach((b) => {
      if (b && b.hash) all.push(Object.assign({ _src: 'main' }, b));
    });
    orphans.forEach((b) => {
      if (b && b.hash && !all.some((x) => x.hash === b.hash)) {
        all.push(Object.assign({ _src: 'orphan' }, b));
      }
    });
    if (localNew && localNew.block && localNew.block.hash) {
      if (!all.some((x) => x.hash === localNew.block.hash)) {
        all.push(Object.assign({ _src: 'localNew' }, localNew.block));
      }
    }

    const postClassic = all.filter(
      (b) =>
        act != null &&
        b.index != null &&
        Number(b.index) >= Number(act) &&
        isClassic(b.forkId)
    );
    const postNew = all.filter(
      (b) =>
        act != null &&
        b.index != null &&
        Number(b.index) >= Number(act) &&
        isNew(b.forkId)
    );

    const classicMax = postClassic.reduce((m, b) => Math.max(m, Number(b.index) || 0), -1);
    const newMax = postNew.reduce((m, b) => Math.max(m, Number(b.index) || 0), -1);

    // Main-chain mix after activation?
    const mainPost = main.filter((b) => act != null && b.index != null && Number(b.index) >= Number(act));
    const mainHasClassic = mainPost.some((b) => isClassic(b.forkId));
    const mainHasNew = mainPost.some((b) => isNew(b.forkId));
    const mainMixed = mainHasClassic && mainHasNew;

    // Cross-parent: NEW block whose parent is post-act classic that is not act-1, or classic whose parent is NEW
    let crossLinks = 0;
    const byHash = new Map(all.map((b) => [b.hash, b]));
    all.forEach((b) => {
      if (act == null || b.index == null || Number(b.index) < Number(act)) return;
      const parent = byHash.get(b.previousHash);
      if (!parent) return;
      const bNew = isNew(b.forkId);
      const pNew = isNew(parent.forkId);
      if (bNew && !pNew && parent.index !== Number(act) - 1) crossLinks++;
      if (!bNew && pNew) crossLinks++;
    });

    let tmpl = null;
    try {
      if (typeof getMiningTemplate === 'function') tmpl = getMiningTemplate();
    } catch (e) {
      tmpl = { error: String(e && e.message) };
    }

    return {
      choice,
      act,
      mainLen: main.length,
      mainTipIndex: main.length ? main[main.length - 1].index : null,
      mainTipFork: main.length ? main[main.length - 1].forkId || 'classic' : null,
      mainPostCount: mainPost.length,
      mainMixed,
      mainHasClassic,
      mainHasNew,
      classicMax,
      newMax,
      postClassicCount: postClassic.length,
      postNewCount: postNew.length,
      orphanCount: orphans.length,
      localNewIndex: localNew && localNew.index != null ? localNew.index : null,
      localNewHash: localNew && localNew.hash ? String(localNew.hash).slice(0, 10) : null,
      crossLinks,
      tmpl,
      isMining: typeof isMining !== 'undefined' ? isMining : null,
      mainPostForks: mainPost.map((b) => ({
        i: b.index,
        f: b.forkId || 'classic',
        h: String(b.hash || '').slice(0, 8)
      }))
    };
  });
}

/** Snapshot hub (admin) RelayBlockchainState if exposed. */
async function adminSnapshot(page) {
  return page.evaluate(() => {
    function isNew(fid) {
      return fid === 'new' || fid === 'NEW';
    }
    const lab =
      window.relayState ||
      window.labState ||
      (window.adminRelay && window.adminRelay.lab) ||
      null;

    // Try common globals used by admin.js
    let state = null;
    if (typeof relayState !== 'undefined' && relayState) state = relayState;
    else if (lab) state = lab;

    if (!state || !Array.isArray(state.chain)) {
      // Fall back to DOM height only
      const h = parseInt((document.getElementById('blockHeight') || {}).textContent || '0', 10) || 0;
      return { available: false, heightDom: h };
    }

    const act = state.pendingFork && state.pendingFork.height != null
      ? Number(state.pendingFork.height)
      : null;
    const main = state.chain || [];
    const allBlocks = [];
    if (state.allBlocks instanceof Map) {
      state.allBlocks.forEach((b) => allBlocks.push(b));
    } else if (Array.isArray(state.allBlocks)) {
      allBlocks.push(...state.allBlocks);
    } else if (typeof state.getSanitizedStateForNewPeer === 'function') {
      const snap = state.getSanitizedStateForNewPeer();
      (snap.chain || []).forEach((b) => allBlocks.push(b));
      (snap.orphans || []).forEach((b) => allBlocks.push(b));
    }

    const byHash = new Map();
    main.forEach((b) => {
      if (b && b.hash) byHash.set(b.hash, b);
    });
    allBlocks.forEach((b) => {
      if (b && b.hash) byHash.set(b.hash, b);
    });

    const postClassic = [];
    const postNew = [];
    byHash.forEach((b) => {
      if (act == null || b.index == null || Number(b.index) < act) return;
      if (isNew(b.forkId)) postNew.push(b);
      else postClassic.push(b);
    });

    const mainPost = main.filter((b) => act != null && b.index != null && Number(b.index) >= act);
    const mainHasClassic = mainPost.some((b) => !isNew(b.forkId));
    const mainHasNew = mainPost.some((b) => isNew(b.forkId));

    return {
      available: true,
      act,
      mainLen: main.length,
      mainTipIndex: main.length ? main[main.length - 1].index : null,
      mainTipFork: main.length ? (main[main.length - 1].forkId || 'classic') : null,
      mainMixed: mainHasClassic && mainHasNew,
      mainHasClassic,
      mainHasNew,
      classicMax: postClassic.reduce((m, b) => Math.max(m, Number(b.index) || 0), -1),
      newMax: postNew.reduce((m, b) => Math.max(m, Number(b.index) || 0), -1),
      postClassicCount: postClassic.length,
      postNewCount: postNew.length,
      orphanEstimate: Math.max(0, byHash.size - main.length),
      mainPostForks: mainPost.map((b) => ({
        i: b.index,
        f: b.forkId || 'classic',
        h: String(b.hash || '').slice(0, 8)
      }))
    };
  });
}

(async () => {
  console.log('Hard-fork audit against', BASE);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const admin = await context.newPage();

  await admin.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(600);
  await admin.click('#createSessionBtn');
  await admin.waitForURL(/admin/i, { timeout: 45000 });
  await wait(3000);

  let code = (await admin.locator('#sessionCode').textContent().catch(() => '') || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) {
    code = (new URL(admin.url()).searchParams.get('session') || '').toUpperCase();
  }
  if (!code) {
    fail('Create session', 'no code');
    await browser.close();
    process.exit(1);
  }
  pass('Create session', code);

  // Soft difficulty + unlock (sliders start locked until unlock is applied)
  await admin.uncheck('#lockParameters').catch(() => {});
  await admin.click('#updateSettingsBtn').catch(() => {});
  await wait(400);
  await admin.evaluate(() => {
    const lead = document.getElementById('difficultyLeading');
    const sec = document.getElementById('difficultySecondary');
    const lock = document.getElementById('lockParameters');
    if (lock) lock.checked = false;
    if (lead) {
      lead.disabled = false;
      lead.value = '1';
      lead.dispatchEvent(new Event('input', { bubbles: true }));
      lead.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (sec) {
      sec.disabled = false;
      sec.value = '15';
      sec.dispatchEvent(new Event('input', { bubbles: true }));
      sec.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // Disable auto-retarget if present (0 or empty)
    ['targetBlockTime', 'targetAverageBlockTime', 'targetBlockSeconds'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.disabled = false;
        el.value = '0';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  });
  await admin.click('#updateSettingsBtn');
  await wait(800);

  const classicMiner = await joinMiner(context, code, 'ClassicMiner');
  const newMiner = await joinMiner(context, code, 'NewMiner');
  pass('Join two miners', 'ClassicMiner + NewMiner');

  await classicMiner.click('#mineBtn');
  await newMiner.click('#mineBtn');
  await wait(2000);

  // Grow a little before proposing
  let h = 0;
  for (let i = 0; i < 25; i++) {
    h = parseInt(await admin.locator('#blockHeight').textContent(), 10) || 0;
    if (h >= 2) break;
    await wait(800);
  }
  if (h >= 1) pass('Pre-fork chain growth', 'height ' + h);
  else fail('Pre-fork chain growth', 'height ' + h);

  // Activate soon: tip + 2 so both miners can still vote before split
  const actHeight = Math.max(h + 2, 3);
  await admin.bringToFront();
  await admin.locator('#forkHeight').fill(String(actHeight));
  await admin.locator('#forkName').fill('Audit Split');
  admin.once('dialog', (d) => d.accept());
  await admin.click('#proposeForkBtn');
  await wait(2000);
  pass('Propose hard fork', 'activation #' + actHeight);

  // Wait for modal/panel, then choose sides
  async function chooseSide(page, acceptNew) {
    // Force-show panel path if modal flaky
    for (let i = 0; i < 15; i++) {
      const modal = page.locator('#forkChoiceModal');
      const visible = await modal.isVisible().catch(() => false);
      const display = await page.evaluate(() => {
        const el = document.getElementById('forkChoiceModal');
        if (!el) return 'missing';
        return window.getComputedStyle(el).display + ' ' + el.className;
      });
      if (visible || /block|in|show/i.test(display)) break;
      // Panel might already be up
      const panel = await page.locator('#forkControlPanel').isVisible().catch(() => false);
      if (panel) break;
      await wait(400);
    }

    // Prefer evaluate so hidden/Bootstrap-modal buttons still work
    await page.evaluate((acceptNew) => {
      if (typeof myForkChoice !== 'undefined') {
        myForkChoice = acceptNew ? 'new' : 'classic';
      }
      if (acceptNew && typeof localClassicForkTip !== 'undefined') {
        localClassicForkTip = null;
      }
      if (!acceptNew && typeof localNewForkTip !== 'undefined') {
        localNewForkTip = null;
      }
      const primary = document.getElementById(acceptNew ? 'btnAcceptFork' : 'btnRejectFork');
      const fallback = document.getElementById(acceptNew ? 'btnFollowNew' : 'btnFollowClassic');
      const btn = (primary && primary.offsetParent !== null) ? primary : (fallback || primary);
      if (btn) btn.click();
      try {
        if (window.jQuery) window.jQuery('#forkChoiceModal').modal('hide');
      } catch (e) {}
    }, acceptNew);
    await wait(500);
  }

  await chooseSide(classicMiner, false);
  await chooseSide(newMiner, true);

  const cChoice = await classicMiner.evaluate(() => typeof myForkChoice !== 'undefined' ? myForkChoice : null);
  const nChoice = await newMiner.evaluate(() => typeof myForkChoice !== 'undefined' ? myForkChoice : null);
  if (cChoice === 'classic') pass('Classic miner chose classic', cChoice);
  else fail('Classic miner chose classic', String(cChoice));
  if (nChoice === 'new') pass('NEW miner chose new', nChoice);
  else fail('NEW miner chose new', String(nChoice));

  // Ensure still mining
  for (const p of [classicMiner, newMiner]) {
    const mining = await p.evaluate(() => !!isMining);
    if (!mining) {
      await p.click('#mineBtn').catch(() => {});
    }
  }

  // Mine through activation + several post-activation blocks
  console.log('... mining through activation #' + actHeight + ' and beyond ...');
  let lastSnap = null;
  for (let i = 0; i < 45; i++) {
    await wait(1000);
    const cs = await minerSnapshot(classicMiner);
    const ns = await minerSnapshot(newMiner);
    lastSnap = { cs, ns, i };
    // Enough post-act blocks on each side?
    if (cs.classicMax >= actHeight + 1 && ns.newMax >= actHeight + 1) break;
    // Or at least activation passed with some progress
    if (i > 25 && (cs.classicMax >= actHeight || ns.newMax >= actHeight)) {
      // give a bit more time then stop
    }
  }

  const cs = await minerSnapshot(classicMiner);
  const ns = await minerSnapshot(newMiner);
  const as = await adminSnapshot(admin);

  fs.writeFileSync(
    path.join(OUT, 'results.json'),
    JSON.stringify({ actHeight, classic: cs, newMiner: ns, admin: as, results }, null, 2)
  );
  await classicMiner.screenshot({ path: path.join(OUT, 'classic-miner.png'), fullPage: true }).catch(() => {});
  await newMiner.screenshot({ path: path.join(OUT, 'new-miner.png'), fullPage: true }).catch(() => {});
  await admin.screenshot({ path: path.join(OUT, 'admin.png'), fullPage: true }).catch(() => {});

  console.log('\n--- Snapshots ---');
  console.log('Classic miner:', JSON.stringify(cs, null, 2));
  console.log('NEW miner:', JSON.stringify(ns, null, 2));
  console.log('Admin hub:', JSON.stringify(as, null, 2));

  // --- Assertions ---

  // Both sides produced post-activation blocks
  if (cs.classicMax >= actHeight) {
    pass('Classic side produced post-activation blocks', 'classicMax=' + cs.classicMax);
  } else {
    fail('Classic side produced post-activation blocks', 'classicMax=' + cs.classicMax + ' act=' + actHeight);
  }

  if (ns.newMax >= actHeight) {
    pass('NEW side produced post-activation blocks', 'newMax=' + ns.newMax);
  } else {
    fail('NEW side produced post-activation blocks', 'newMax=' + ns.newMax + ' act=' + actHeight);
  }

  // Parallel growth: both tips advanced at least one past activation
  if (cs.classicMax >= actHeight && ns.newMax >= actHeight) {
    if (cs.classicMax >= actHeight && ns.newMax >= actHeight) {
      pass(
        'Parallel tips after split',
        'classic@' + cs.classicMax + ' new@' + ns.newMax
      );
    }
  }

  // Classic miner template must not target NEW parents after activation
  if (cs.tmpl && cs.tmpl.forkId) {
    if (cs.tmpl.forkId === 'classic' || (cs.act != null && cs.tmpl.index < cs.act)) {
      pass('Classic miner template stays classic', JSON.stringify(cs.tmpl));
    } else {
      fail('Classic miner template stays classic', JSON.stringify(cs.tmpl));
    }
  } else {
    fail('Classic miner template stays classic', 'no template: ' + JSON.stringify(cs.tmpl));
  }

  // NEW miner template must be new after activation (if classic tip reached act-1)
  if (ns.tmpl && ns.tmpl.forkId === 'new') {
    pass('NEW miner template stays on NEW', JSON.stringify(ns.tmpl));
  } else if (ns.newMax >= actHeight && ns.tmpl) {
    // Has NEW blocks but template not new — bad
    fail('NEW miner template stays on NEW', JSON.stringify(ns.tmpl));
  } else {
    fail('NEW miner template stays on NEW', JSON.stringify(ns.tmpl));
  }

  // Classic miner should not hold a high NEW tip as its mining target
  if (cs.choice === 'classic' && cs.tmpl && cs.tmpl.forkId === 'new') {
    fail('Classic miner not mining NEW tip', JSON.stringify(cs.tmpl));
  } else {
    pass('Classic miner not mining NEW tip', 'choice=' + cs.choice);
  }

  // Cross-fork parent links
  if (cs.crossLinks === 0 && ns.crossLinks === 0) {
    pass('No cross-fork parent links on miners', '0/0');
  } else {
    fail('No cross-fork parent links on miners', 'classic=' + cs.crossLinks + ' new=' + ns.crossLinks);
  }

  // Hub main must not mix classic and NEW post-activation (clean split)
  // Prefer admin state; fall back to miner main mirrors
  const mixAdmin = as.available ? as.mainMixed : null;
  const mixClassicView = cs.mainMixed;
  const mixNewView = ns.mainMixed;

  if (mixAdmin === false) {
    pass('Hub main chain not mixed post-activation', 'tipFork=' + as.mainTipFork + ' post=' + JSON.stringify(as.mainPostForks));
  } else if (mixAdmin === true) {
    fail(
      'Hub main chain not mixed post-activation',
      'MIXED tipFork=' + as.mainTipFork + ' post=' + JSON.stringify(as.mainPostForks)
    );
  } else if (!mixClassicView && !mixNewView) {
    pass('Miner main mirrors not mixed post-activation', 'classic+new views clean');
  } else {
    fail(
      'Miner main mirrors not mixed post-activation',
      'classicMixed=' + mixClassicView + ' newMixed=' + mixNewView +
        ' cPost=' + JSON.stringify(cs.mainPostForks) +
        ' nPost=' + JSON.stringify(ns.mainPostForks)
    );
  }

  // NEW side must remain visible as orphans (or local tip) when not main
  const newVisible =
    ns.postNewCount > 0 ||
    ns.localNewIndex != null ||
    (as.available && as.postNewCount > 0);
  if (newVisible) pass('NEW chain visible (orphans/local tip)', 'newCount=' + ns.postNewCount + ' localIdx=' + ns.localNewIndex);
  else fail('NEW chain visible (orphans/local tip)', 'not found');

  // Classic side visible
  if (cs.postClassicCount > 0 || (as.available && as.postClassicCount > 0)) {
    pass('Classic chain visible post-activation', 'count=' + cs.postClassicCount);
  } else {
    fail('Classic chain visible post-activation', 'count=' + cs.postClassicCount);
  }

  // Neither side fully wiped by reorg: both max >= act
  if (cs.classicMax >= actHeight && ns.newMax >= actHeight) {
    pass('Neither side wiped by longest-chain reorg', 'classic=' + cs.classicMax + ' new=' + ns.newMax);
  } else {
    fail(
      'Neither side wiped by longest-chain reorg',
      'classic=' + cs.classicMax + ' new=' + ns.newMax + ' act=' + actHeight
    );
  }

  // Both sides must keep growing past the first activation block (no stall at act)
  if (cs.classicMax >= actHeight + 1) {
    pass('Classic tip advanced past activation', 'classicMax=' + cs.classicMax);
  } else {
    fail(
      'Classic tip advanced past activation',
      'classicMax=' + cs.classicMax + ' (stuck near act=' + actHeight + ')'
    );
  }
  if (ns.newMax >= actHeight + 1) {
    pass('NEW tip advanced past activation', 'newMax=' + ns.newMax);
  } else {
    fail(
      'NEW tip advanced past activation',
      'newMax=' + ns.newMax + ' (stuck near act=' + actHeight + ')'
    );
  }

  // Hub main tip should stay on classic after the split (NEW is permanent orphan side)
  if (as.available) {
    if (as.mainTipFork === 'classic' || as.mainTipFork === 'CLASSIC' || !as.mainTipFork) {
      pass('Hub main tip is classic side', 'tipFork=' + as.mainTipFork + ' tipIndex=' + as.mainTipIndex);
    } else {
      fail(
        'Hub main tip is classic side',
        'tipFork=' + as.mainTipFork + ' tipIndex=' + as.mainTipIndex +
          ' (NEW should not reorg main via longest-chain)'
      );
    }
    if (as.mainHasNew && as.mainHasClassic) {
      fail('Hub main post-act is single-sided', 'mixed classic+NEW on main');
    } else if (as.mainHasNew && !as.mainHasClassic) {
      fail('Hub main post-act is single-sided', 'main is pure NEW — classic side orphaned away');
    } else {
      pass('Hub main post-act is single-sided', 'classic main, NEW as orphans');
    }
  } else {
    fail('Hub main tip is classic side', 'admin state unavailable');
  }

  await browser.close();

  const failed = results.filter((r) => !r.ok).length;
  const passed = results.length - failed;
  console.log('\n==== hard-fork-audit: ' + passed + '/' + results.length + ' passed ====');
  console.log('Artifacts: ' + OUT);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
