/**
 * Shared helpers for lab chain UI: full addresses, node names, copy buttons.
 * Loaded before participate.js / observe.js / admin.js.
 */
(function (window) {
  'use strict';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  function participantDisplayName(p) {
    if (!p) return '';
    var nm = p.displayName || p.name || '';
    return nm ? String(nm).trim() : '';
  }

  function buildParticipantNameLookup(participants) {
    var map = Object.create(null);
    if (!participants || !participants.length) return map;
    for (var i = 0; i < participants.length; i++) {
      var p = participants[i];
      if (!p) continue;
      var nm = participantDisplayName(p);
      if (!nm) continue;
      if (p.userId) map[String(p.userId)] = nm;
      if (p.address) map[String(p.address)] = nm;
      if (p.id) map[String(p.id)] = nm;
      // Some relays only put the id on `miner` / address fields inconsistently
      if (p.miner) map[String(p.miner)] = nm;
    }
    return map;
  }

  /** Shorten long hex ids for narrow screens while keeping full value in title/copy. */
  function shortAddress(addr) {
    var s = String(addr || '');
    if (s.length <= 14) return s;
    return s.slice(0, 6) + '…' + s.slice(-4);
  }

  /**
   * Renders address with optional node name beside it, plus copy control.
   * Name is always on its own line first so mobile doesn't hide it behind long ids.
   * @param {string} address miner or wallet id
   * @param {Record<string,string>} nameLookup address/userId -> display name
   */
  function formatChainParticipantHtml(address, nameLookup) {
    var addr = address == null ? '' : String(address);
    if (!addr) return '<span class="text-muted">—</span>';
    var isSystem = addr === 'system' || addr === 'genesis' || addr === 'Genesis';
    var nm = '';
    if (!isSystem && nameLookup) {
      nm = nameLookup[addr] ? String(nameLookup[addr]).trim() : '';
      // Case-insensitive fallback (some mobile WebViews normalize ids)
      if (!nm) {
        var lower = addr.toLowerCase();
        for (var k in nameLookup) {
          if (Object.prototype.hasOwnProperty.call(nameLookup, k) && String(k).toLowerCase() === lower) {
            nm = String(nameLookup[k]).trim();
            break;
          }
        }
      }
    }

    var copyBtn = '';
    if (!isSystem) {
      copyBtn =
        '<button type="button" class="btn btn-xs btn-default copy-btn" data-clipboard-text="' +
        escapeAttr(addr) +
        '" title="Copy address" aria-label="Copy address" style="flex-shrink:0;"><i class="glyphicon glyphicon-copy"></i></button>';
    }

    var nameBit = nm
      ? '<div class="chain-node-name" style="font-weight:700;font-size:13px;line-height:1.25;margin:0 0 2px 0;word-break:break-word;">' +
        escapeHtml(nm) +
        '</div>'
      : '';

    var addrHtml = isSystem
      ? '<code class="chain-address-full" style="font-size:11px;margin:0;">' + escapeHtml(addr) + '</code>'
      : '<code class="chain-address-full" title="' +
        escapeAttr(addr) +
        '" style="font-size:10px;word-break:break-all;flex:1;min-width:0;margin:0;">' +
        '<span class="chain-address-short">' +
        escapeHtml(shortAddress(addr)) +
        '</span><span class="chain-address-long">' +
        escapeHtml(addr) +
        '</span></code>';

    return (
      '<div class="chain-id-row" style="display:flex;flex-direction:column;align-items:stretch;gap:2px;max-width:100%;">' +
      nameBit +
      '<div style="display:flex;align-items:center;gap:6px;min-width:0;">' +
      addrHtml +
      copyBtn +
      '</div></div>'
    );
  }

  function isNewForkId(fid) {
    return fid === 'new' || fid === 'NEW';
  }

  /**
   * Label for non-main blocks: hard-fork side vs true race orphan.
   */
  function sideChainLabel(block) {
    if (!block) {
      return { text: 'SIDE', cls: 'label-warning', panel: 'panel-warning' };
    }
    if (isNewForkId(block.forkId)) {
      return { text: 'NEW CHAIN', cls: 'label-info', panel: 'panel-info' };
    }
    var fid = block.forkId && block.forkId !== 'classic' ? String(block.forkId) : '';
    if (fid) {
      return {
        text: fid.toUpperCase() + ' CHAIN',
        cls: 'label-info',
        panel: 'panel-info'
      };
    }
    // Same rules / classic competing tip that lost longest-chain race
    return { text: 'ORPHAN', cls: 'label-warning', panel: 'panel-warning' };
  }

  /**
   * Hard caps for projector / wallet / miner chain cards.
   * Windowing to 24 still painted a long vertical stack of full Bootstrap
   * panels (O5E46U wallet Aw Snap; 0HU8XV hub at 5 seats / 0.3s).
   * Callers may request 24; renderChainHtml never exceeds these.
   */
  var HARD_MAX_VISIBLE = 10;
  var MAX_ORPHANS_PER_HEIGHT = 2;
  var MAX_ORPHAN_CARDS = 6;
  var MAX_TOTAL_CARDS = 14;
  var MAX_TX_ROWS = 6;

  /**
   * Keep genesis + the last `maxVisible` heights so a 200-block class
   * does not rebuild hundreds of panels every tip (Chrome Aw Snap).
   */
  function windowBlocksForDisplay(blocks, maxVisible) {
    var list = Array.isArray(blocks) ? blocks.slice() : [];
    var cap = maxVisible == null ? HARD_MAX_VISIBLE : Math.max(4, Number(maxVisible) || HARD_MAX_VISIBLE);
    if (list.length <= cap) {
      return { blocks: list, omitted: 0, keptGenesis: false };
    }
    var genesis = [];
    var rest = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (b && (b.index === 0 || b.miner === 'genesis')) genesis.push(b);
      else rest.push(b);
    }
    var keepTail = Math.max(1, cap - (genesis.length ? 1 : 0));
    var tail = rest.slice(-keepTail);
    var omitted = Math.max(0, list.length - genesis.length - tail.length);
    var out = genesis.length ? genesis.slice(0, 1).concat(tail) : tail;
    return { blocks: out, omitted: omitted, keptGenesis: genesis.length > 0 };
  }

  var archiveOpen = false;
  var archiveSelected = '';
  var lastArchiveLookup = Object.create(null);
  var lastNameLookup = null;
  var lastOpenTxPanels = null;

  function collectOmittedBlocks(rawMain, windowed) {
    var keep = Object.create(null);
    var shown = (windowed && windowed.blocks) || [];
    for (var i = 0; i < shown.length; i++) {
      if (shown[i] && shown[i].hash) keep[String(shown[i].hash)] = true;
    }
    var out = [];
    var list = Array.isArray(rawMain) ? rawMain : [];
    for (var j = 0; j < list.length; j++) {
      var b = list[j];
      if (b && b.hash && !keep[String(b.hash)]) out.push(b);
    }
    out.sort(function (a, b) {
      return Number(a.index) - Number(b.index);
    });
    return out;
  }

  function renderOneArchiveCard(block, nameLookup, openTxPanels) {
    if (!block) return '';
    var fmtAddr = function (addr) {
      return formatChainParticipantHtml(addr, nameLookup);
    };
    var hashFull = String(block.hash || '');
    var prevFull = String(block.previousHash || '');
    var hashShort = hashFull.length > 16 ? hashFull.substring(0, 16) + '…' : hashFull;
    var prevShort = prevFull.length > 16 ? prevFull.substring(0, 16) + '…' : prevFull;
    var timeStr = block.timestamp ? new Date(block.timestamp).toLocaleTimeString() : '';
    var txHtml = String(block.transactions ? block.transactions.length : 0);
    if (block.transactions && block.transactions.length > 0) {
      var txId = 'tx_archive_' + hashFull;
      var open = openTxPanels && typeof openTxPanels.has === 'function' && openTxPanels.has(txId);
      txHtml +=
        ' <button class="btn btn-xs btn-default" type="button" onclick="toggleTransactions(\'' +
        escapeAttr(txId) +
        '\')">View Details</button>';
      txHtml +=
        '<div id="txDetails_' +
        escapeAttr(txId) +
        '" style="display:' +
        (open ? 'block' : 'none') +
        ';margin-top:10px;max-height:150px;overflow-y:auto;">';
      txHtml +=
        '<table class="table table-condensed"><thead><tr><th>From</th><th>To</th><th>Amt</th></tr></thead><tbody>';
      var txLimit = Math.min(block.transactions.length, MAX_TX_ROWS);
      for (var t = 0; t < txLimit; t++) {
        var tx = block.transactions[t];
        txHtml +=
          '<tr><td>' +
          fmtAddr(tx.from) +
          '</td><td>' +
          fmtAddr(tx.to) +
          '</td><td>' +
          escapeHtml(tx.amount) +
          '</td></tr>';
      }
      if (block.transactions.length > txLimit) {
        txHtml +=
          '<tr><td colspan="3" class="text-muted small">+' +
          (block.transactions.length - txLimit) +
          ' more</td></tr>';
      }
      txHtml += '</tbody></table></div>';
    }
    return (
      '<div class="panel panel-default chain-archive-card" style="margin:10px 0 0;">' +
      '<div class="panel-heading" style="padding:8px 15px;">' +
      '<strong>Block #' +
      escapeHtml(block.index) +
      '</strong>' +
      '<div class="pull-right text-muted small" style="margin-top:2px;">' +
      escapeHtml(timeStr) +
      '</div></div>' +
      '<div class="panel-body" style="padding:10px 15px;">' +
      '<dl class="dl-horizontal chain-block-dl" style="margin-bottom:0;">' +
      '<dt>Hash</dt><dd><code class="chain-hash" title="' +
      escapeAttr(hashFull) +
      '">' +
      escapeHtml(hashShort) +
      '</code></dd>' +
      '<dt>Prev</dt><dd><code class="chain-hash" title="' +
      escapeAttr(prevFull) +
      '">' +
      escapeHtml(prevShort) +
      '</code></dd>' +
      '<dt>Miner</dt><dd>' +
      fmtAddr(block.miner) +
      '</dd>' +
      '<dt>Nonce</dt><dd>' +
      escapeHtml(block.nonce) +
      '</dd>' +
      '<dt>Txs</dt><dd>' +
      txHtml +
      '</dd></dl></div></div>'
    );
  }

  function renderHiddenBlocksControl(omitted, omittedBlocks, nameLookup, openTxPanels) {
    if (!(omitted > 0)) return '';
    bindArchiveDelegation();
    lastArchiveLookup = Object.create(null);
    lastNameLookup = nameLookup || null;
    lastOpenTxPanels = openTxPanels || null;
    var rows = Array.isArray(omittedBlocks) ? omittedBlocks : [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].hash) lastArchiveLookup[String(rows[i].hash)] = rows[i];
    }
    if (archiveSelected && !lastArchiveLookup[archiveSelected]) archiveSelected = '';
    var btnLabel = archiveOpen
      ? 'Hide earlier blocks'
      : 'Browse ' + omitted + ' earlier block' + (omitted === 1 ? '' : 's');
    var html =
      '<div class="chain-omitted">' +
      '<div class="chain-omitted-bar">' +
      '<button type="button" class="btn btn-xs btn-default" data-chain-archive-toggle="1" data-omitted="' +
      omitted +
      '">' +
      escapeHtml(btnLabel) +
      '</button>' +
      '<span class="text-muted small"> Hidden from the live view so this tab stays responsive.</span>' +
      '</div>' +
      '<div class="chain-archive-panel" style="display:' +
      (archiveOpen ? 'block' : 'none') +
      ';">' +
      '<p class="small text-muted" style="margin:8px 0 6px;">' +
      'Earlier blocks are still on the chain. Click a row to inspect it — the live tip stays windowed.</p>' +
      '<div class="chain-archive-table-wrap"><table class="table table-condensed table-hover chain-archive-table">' +
      '<thead><tr><th>#</th><th>Time</th><th>Miner</th><th>Hash</th><th>Txs</th></tr></thead><tbody>';
    for (var r = 0; r < rows.length; r++) {
      var b = rows[r];
      if (!b) continue;
      var h = String(b.hash || '');
      var miner = String(b.miner || '');
      var active = archiveSelected && archiveSelected === h ? ' chain-archive-row--active' : '';
      html +=
        '<tr class="chain-archive-row' +
        active +
        '" data-chain-archive-hash="' +
        escapeAttr(h) +
        '">' +
        '<td>' +
        escapeHtml(b.index) +
        '</td>' +
        '<td>' +
        escapeHtml(b.timestamp ? new Date(b.timestamp).toLocaleTimeString() : '') +
        '</td>' +
        '<td>' +
        escapeHtml(miner.length > 18 ? miner.slice(0, 8) + '…' + miner.slice(-4) : miner) +
        '</td>' +
        '<td><code title="' +
        escapeAttr(h) +
        '">' +
        escapeHtml(h.length > 16 ? h.slice(0, 16) + '…' : h) +
        '</code></td>' +
        '<td>' +
        escapeHtml(b.transactions ? b.transactions.length : 0) +
        '</td></tr>';
    }
    html += '</tbody></table></div><div class="chain-archive-detail">';
    if (archiveOpen && archiveSelected && lastArchiveLookup[archiveSelected]) {
      html += renderOneArchiveCard(lastArchiveLookup[archiveSelected], nameLookup, openTxPanels);
    }
    html += '</div></div></div>';
    return html;
  }

  function omittedRowHtml(omitted, omittedBlocks, nameLookup, openTxPanels) {
    return renderHiddenBlocksControl(omitted, omittedBlocks, nameLookup, openTxPanels);
  }

  function bindArchiveDelegation() {
    if (bindArchiveDelegation._done) return;
    var doc = (typeof document !== 'undefined') ? document : (window && window.document);
    if (!doc || typeof doc.addEventListener !== 'function') return;
    bindArchiveDelegation._done = true;
    doc.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var toggle = t.closest('[data-chain-archive-toggle]');
      if (toggle) {
        ev.preventDefault();
        ev.stopPropagation();
        archiveOpen = !archiveOpen;
        var root = toggle.closest('.chain-omitted');
        var panel = root && root.querySelector('.chain-archive-panel');
        if (panel) panel.style.display = archiveOpen ? 'block' : 'none';
        var n = Number(toggle.getAttribute('data-omitted')) || 0;
        toggle.textContent = archiveOpen
          ? 'Hide earlier blocks'
          : 'Browse ' + n + ' earlier block' + (n === 1 ? '' : 's');
        if (archiveOpen && typeof window.LabOnArchiveOpen === 'function') {
          try { window.LabOnArchiveOpen(); } catch (e) {}
        }
        return;
      }
      var row = t.closest('[data-chain-archive-hash]');
      if (!row) return;
      ev.preventDefault();
      archiveSelected = row.getAttribute('data-chain-archive-hash') || '';
      var box = row.closest('.chain-omitted');
      var detail = box && box.querySelector('.chain-archive-detail');
      var siblings = box ? box.querySelectorAll('[data-chain-archive-hash]') : [];
      for (var i = 0; i < siblings.length; i++) {
        siblings[i].classList.toggle('chain-archive-row--active', siblings[i] === row);
      }
      if (detail && lastArchiveLookup[archiveSelected]) {
        detail.innerHTML = renderOneArchiveCard(
          lastArchiveLookup[archiveSelected],
          lastNameLookup,
          lastOpenTxPanels
        );
      }
    });
  }

  /**
   * Render main chain + orphans with parent-aligned columns and simple arrows.
   * @param {object} opts
   * @param {Array} opts.mainChain
   * @param {Array} [opts.orphans]
   * @param {Array} [opts.participants]
   * @param {Set|object} [opts.openTxPanels] Set of open tx panel ids
   * @param {function} [opts.onToggleTx] unused — onclick uses global toggleTransactions
   * @returns {string} HTML
   */
  function renderChainHtml(opts) {
    opts = opts || {};
    var requested = opts.maxVisible == null ? HARD_MAX_VISIBLE : opts.maxVisible;
    var maxVisible = Math.min(HARD_MAX_VISIBLE, Math.max(4, Number(requested) || HARD_MAX_VISIBLE));
    var rawMain = opts.mainChain || [];
    var windowed = windowBlocksForDisplay(rawMain, maxVisible);
    var mainChain = windowed.blocks;
    var orphans = opts.orphans || [];
    var hubHeight = opts.hubHeight;
    if (hubHeight != null && !isNaN(Number(hubHeight))) {
      var cap = Number(hubHeight);
      orphans = orphans.filter(function (b) {
        if (!b) return false;
        if (b.index == null) return true;
        return Number(b.index) <= cap;
      });
    }
    var visibleMin = 0;
    for (var wi = 0; wi < mainChain.length; wi++) {
      if (mainChain[wi] && mainChain[wi].index != null && Number(mainChain[wi].index) > 0) {
        visibleMin = Number(mainChain[wi].index);
        break;
      }
    }
    if (visibleMin > 1) {
      orphans = orphans.filter(function (b) {
        if (!b) return false;
        if (b.index == null) return true;
        var oidx = Number(b.index);
        return oidx === 0 || oidx >= visibleMin;
      });
    }
    var participants = opts.participants || [];
    var openTxPanels = opts.openTxPanels || null;
    var nameLookup = buildParticipantNameLookup(participants);
    var fmtAddr = function (addr) {
      return formatChainParticipantHtml(addr, nameLookup);
    };

    var allBlocks = mainChain.slice();
    var mainHashes = {};
    for (var mi = 0; mi < mainChain.length; mi++) {
      if (mainChain[mi] && mainChain[mi].hash) mainHashes[mainChain[mi].hash] = true;
    }
    for (var oi = 0; oi < orphans.length; oi++) {
      var ob = orphans[oi];
      if (ob && ob.hash && !mainHashes[ob.hash]) allBlocks.push(ob);
    }

    if (!allBlocks.length) {
      return '<p class="text-muted">No blocks yet</p>';
    }

    var byIndex = {};
    var maxIndex = 0;
    for (var bi = 0; bi < allBlocks.length; bi++) {
      var b = allBlocks[bi];
      if (!b || b.index == null) continue;
      var idx = Number(b.index);
      if (!byIndex[idx]) byIndex[idx] = [];
      var dup = false;
      for (var di = 0; di < byIndex[idx].length; di++) {
        if (byIndex[idx][di].hash === b.hash) {
          dup = true;
          break;
        }
      }
      if (!dup) byIndex[idx].push(b);
      if (idx > maxIndex) maxIndex = idx;
    }
    // Cap race-losers per height so the hub/wallet panel cannot grow a
    // full competing column for every miner at every height.
    // Walk tip→genesis so the newest race is kept when the budget runs out.
    var orphanBudget = MAX_ORPHAN_CARDS;
    Object.keys(byIndex).map(Number).sort(function (a, b) { return b - a; }).forEach(function (key) {
      var level = byIndex[key];
      if (!level || !level.length) return;
      var mains = [];
      var others = [];
      for (var li = 0; li < level.length; li++) {
        if (mainHashes[level[li].hash]) mains.push(level[li]);
        else others.push(level[li]);
      }
      var extraRoom = Math.min(
        Math.max(0, MAX_ORPHANS_PER_HEIGHT - mains.length),
        Math.max(0, orphanBudget)
      );
      if (others.length > extraRoom) others = others.slice(0, extraRoom);
      orphanBudget -= others.length;
      byIndex[key] = mains.concat(others);
    });

    function countCards() {
      var n = 0;
      Object.keys(byIndex).forEach(function (k) {
        n += byIndex[k] ? byIndex[k].length : 0;
      });
      return n;
    }
    if (countCards() > MAX_TOTAL_CARDS) {
      var heights = Object.keys(byIndex).map(Number).sort(function (a, b) { return a - b; });
      var keep = {};
      var used = 0;
      if (byIndex[0] && byIndex[0].length) {
        keep[0] = byIndex[0];
        used += byIndex[0].length;
      }
      for (var hi = heights.length - 1; hi >= 0 && used < MAX_TOTAL_CARDS; hi--) {
        var h = heights[hi];
        if (h === 0) continue;
        var lvl = byIndex[h];
        if (!lvl || !lvl.length) continue;
        var room = MAX_TOTAL_CARDS - used;
        keep[h] = lvl.length > room ? lvl.slice(0, room) : lvl;
        used += keep[h].length;
      }
      byIndex = keep;
    }

    function sortLevel(blocks, parentOrder) {
      // Main-chain block first, then by parent position, then hash
      var parentPos = {};
      if (parentOrder) {
        for (var p = 0; p < parentOrder.length; p++) {
          parentPos[parentOrder[p].hash] = p;
        }
      }
      return blocks.slice().sort(function (a, b) {
        var aMain = mainHashes[a.hash] ? 0 : 1;
        var bMain = mainHashes[b.hash] ? 0 : 1;
        if (aMain !== bMain) return aMain - bMain;
        var ap = parentPos[a.previousHash];
        var bp = parentPos[b.previousHash];
        if (ap == null) ap = 999;
        if (bp == null) bp = 999;
        if (ap !== bp) return ap - bp;
        return String(a.hash).localeCompare(String(b.hash));
      });
    }

    bindArchiveDelegation();
    var omittedBlocks = collectOmittedBlocks(rawMain, windowed);
    var html = '<div class="chain-view" style="display:flex;flex-direction:column;width:100%;gap:0;contain:content;">';
    html += omittedRowHtml(windowed.omitted, omittedBlocks, nameLookup, openTxPanels);
    var prevLevel = null;

    for (var i = 0; i <= maxIndex; i++) {
      if (!byIndex[i] || !byIndex[i].length) continue;
      var level = sortLevel(byIndex[i], prevLevel);

      html +=
        '<div class="chain-level" data-height="' +
        i +
        '" style="content-visibility:auto;contain-intrinsic-size:auto 160px;">';

      for (var li = 0; li < level.length; li++) {
        var block = level[li];
        var isMain = !!mainHashes[block.hash];
        var side = !isMain ? sideChainLabel(block) : null;
        var panelClass = isMain
          ? i === maxIndex
            ? 'panel-success'
            : 'panel-primary'
          : side.panel;
        // Hard-fork NEW side is a permanent parallel chain — never call it ORPHAN.
        // True race losers stay ORPHAN (warning).
        var label = '';
        if (!isMain && side) {
          label =
            '<span class="label ' +
            side.cls +
            ' pull-right chain-side-label">' +
            escapeHtml(side.text) +
            '</span>';
        }
        // Avoid double-badging: NEW CHAIN label already implies forkId
        var forkId =
          block.forkId && block.forkId !== 'classic' && !isNewForkId(block.forkId)
            ? String(block.forkId)
            : '';
        var forkBadge = forkId
          ? '<span class="label label-default pull-right" style="margin-right:5px;">' +
            escapeHtml(forkId.toUpperCase()) +
            '</span>'
          : '';

        var txHtml = String(block.transactions ? block.transactions.length : 0);
        if (block.transactions && block.transactions.length > 0) {
          var txId = 'tx_' + block.hash;
          var open = openTxPanels && typeof openTxPanels.has === 'function' && openTxPanels.has(txId);
          var displayStyle = open ? 'block' : 'none';
          txHtml +=
            ' <button class="btn btn-xs btn-default" type="button" onclick="toggleTransactions(\'' +
            escapeAttr(txId) +
            '\')">View Details</button>';
          txHtml +=
            '<div id="txDetails_' +
            escapeAttr(txId) +
            '" style="display:' +
            displayStyle +
            ';margin-top:10px;max-height:150px;overflow-y:auto;">';
          txHtml +=
            '<table class="table table-condensed"><thead><tr><th>From</th><th>To</th><th>Amt</th></tr></thead><tbody>';
          var txLimit = Math.min(block.transactions.length, MAX_TX_ROWS);
          for (var t = 0; t < txLimit; t++) {
            var tx = block.transactions[t];
            txHtml +=
              '<tr><td>' +
              fmtAddr(tx.from) +
              '</td><td>' +
              fmtAddr(tx.to) +
              '</td><td>' +
              escapeHtml(tx.amount) +
              '</td></tr>';
          }
          if (block.transactions.length > txLimit) {
            txHtml +=
              '<tr><td colspan="3" class="text-muted small">+' +
              (block.transactions.length - txLimit) +
              ' more</td></tr>';
          }
          txHtml += '</tbody></table></div>';
        }

        var minerId = block.miner != null ? block.miner : '';
        var hashFull = String(block.hash || '');
        var prevFull = String(block.previousHash || '');
        var hashShort = hashFull.length > 16 ? hashFull.substring(0, 16) + '…' : hashFull;
        var prevShort = prevFull.length > 16 ? prevFull.substring(0, 16) + '…' : prevFull;
        var timeStr = block.timestamp ? new Date(block.timestamp).toLocaleTimeString() : '';
        function hashCode(full, short) {
          var shown = full || '—';
          var shownShort = short || shown;
          return (
            '<code class="chain-hash" title="' +
            escapeAttr(shown) +
            '"><span class="chain-hash-short">' +
            escapeHtml(shownShort) +
            '</span><span class="chain-hash-long">' +
            escapeHtml(shown) +
            '</span></code>'
          );
        }

        // Children of this block at next existing height (may skip if gap)
        var childCount = 0;
        var hasOrphanChild = false;
        for (var j = i + 1; j <= maxIndex; j++) {
          if (!byIndex[j]) continue;
          for (var c = 0; c < byIndex[j].length; c++) {
            if (byIndex[j][c].previousHash === block.hash) {
              childCount++;
              if (!mainHashes[byIndex[j][c].hash]) hasOrphanChild = true;
            }
          }
          break; // only next populated level for arrow UI
        }

        html +=
          '<div class="chain-block-col" data-hash="' +
          escapeAttr(block.hash) +
          '">';
        html +=
          '<div class="panel ' +
          panelClass +
          '" style="width:100%;margin-bottom:0;box-shadow:0 2px 4px rgba(0,0,0,0.1);">';
        html +=
          '<div class="panel-heading" style="padding:8px 15px;">' +
          '<strong>Block #' +
          escapeHtml(block.index) +
          '</strong> ' +
          label +
          ' ' +
          forkBadge +
          '<div class="pull-right text-muted small" style="margin-top:2px;">' +
          escapeHtml(timeStr) +
          '</div></div>';
        html +=
          '<div class="panel-body" style="padding:10px 15px;">' +
          '<dl class="dl-horizontal chain-block-dl" style="margin-bottom:0;">' +
          '<dt>Hash</dt><dd>' +
          hashCode(hashFull, hashShort) +
          '</dd>' +
          '<dt>Prev</dt><dd>' +
          hashCode(prevFull, prevShort) +
          '</dd>' +
          '<dt>Miner</dt><dd>' +
          fmtAddr(minerId) +
          '</dd>' +
          '<dt>Nonce</dt><dd>' +
          escapeHtml(block.nonce) +
          '</dd>' +
          '<dt>Txs</dt><dd>' +
          txHtml +
          '</dd>' +
          '</dl></div></div>';

        // Single down-arrow under this card only if it has children (no multi-angle fan)
        if (childCount > 0) {
          var arrowColor = !isMain
            ? isNewForkId(block.forkId)
              ? '#5bc0de'
              : '#f0ad4e'
            : hasOrphanChild
              ? '#f0ad4e'
              : '#9e9e9e';
          html +=
            '<div style="text-align:center;margin:6px 0 2px;color:' +
            arrowColor +
            ';line-height:1;">' +
            '<i class="glyphicon glyphicon-arrow-down"></i>' +
            (childCount > 1
              ? '<div class="small text-muted" style="font-size:10px;">' +
                childCount +
                ' children</div>'
              : '') +
            '</div>';
        } else if (i < maxIndex) {
          html += '<div style="height:18px;"></div>';
        }

        html += '</div>'; // col
      }

      html += '</div>'; // level
      prevLevel = level;
    }

    html += '</div>';
    return html;
  }

  function chainScrollParent(viewEl) {
    if (!viewEl) return null;
    var p = viewEl.parentElement;
    while (p && p !== document.body) {
      var overflowY = '';
      try {
        overflowY = (window.getComputedStyle ? window.getComputedStyle(p).overflowY : p.style.overflowY) || '';
      } catch (e) {}
      if (overflowY === 'auto' || overflowY === 'scroll') return p;
      p = p.parentElement;
    }
    return viewEl;
  }

  /**
   * Keep the inner chain panel on the tip unless the student scrolled up
   * to inspect earlier cards (Wallet 1 was stuck at genesis at height 163).
   */
  function pinChainPanelToTip(viewEl, opts) {
    opts = opts || {};
    if (archiveOpen) return;
    var scroller = chainScrollParent(viewEl);
    if (!scroller) return;
    var slack = opts.slack != null ? opts.slack : 96;
    var fromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (!opts.force && fromBottom > slack) return;
    scroller.scrollTop = scroller.scrollHeight;
  }

  window.ChainDisplay = {
    escapeHtml: escapeHtml,
    buildParticipantNameLookup: buildParticipantNameLookup,
    formatChainParticipantHtml: formatChainParticipantHtml,
    renderChainHtml: renderChainHtml,
    windowBlocksForDisplay: windowBlocksForDisplay,
    renderHiddenBlocksControl: renderHiddenBlocksControl,
    collectOmittedBlocks: collectOmittedBlocks,
    pinChainPanelToTip: pinChainPanelToTip,
    chainScrollParent: chainScrollParent,
    sideChainLabel: sideChainLabel,
    shortAddress: shortAddress,
    HARD_MAX_VISIBLE: HARD_MAX_VISIBLE,
    MAX_ORPHANS_PER_HEIGHT: MAX_ORPHANS_PER_HEIGHT,
    MAX_ORPHAN_CARDS: MAX_ORPHAN_CARDS,
    MAX_TOTAL_CARDS: MAX_TOTAL_CARDS
  };
})(typeof window !== 'undefined' ? window : this);
