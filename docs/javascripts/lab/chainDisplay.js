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
    }
    return map;
  }

  /**
   * Renders address with optional node name beside it, plus copy control.
   * @param {string} address miner or wallet id
   * @param {Record<string,string>} nameLookup address/userId -> display name
   */
  function formatChainParticipantHtml(address, nameLookup) {
    var addr = address == null ? '' : String(address);
    if (!addr) return '<span class="text-muted">—</span>';
    var isSystem = addr === 'system' || addr === 'genesis';
    var nm = !isSystem && nameLookup && nameLookup[addr] ? String(nameLookup[addr]).trim() : '';

    var copyBtn = '';
    if (!isSystem) {
      copyBtn =
        '<button type="button" class="btn btn-xs btn-default copy-btn" data-clipboard-text="' +
        escapeAttr(addr) +
        '" title="Copy address" aria-label="Copy address" style="flex-shrink:0;"><i class="glyphicon glyphicon-copy"></i></button>';
    }

    var nameBit = nm
      ? '<strong class="chain-node-name" style="margin-right:6px;white-space:nowrap;">' +
        escapeHtml(nm) +
        '</strong>'
      : '';

    return (
      '<div class="chain-id-row" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
      nameBit +
      '<code class="chain-address-full" style="font-size:11px;word-break:break-all;flex:1;min-width:0;margin:0;">' +
      escapeHtml(addr) +
      '</code>' +
      copyBtn +
      '</div>'
    );
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
    var mainChain = opts.mainChain || [];
    var orphans = opts.orphans || [];
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

    var html = '<div class="chain-view" style="display:flex;flex-direction:column;width:100%;gap:0;">';
    var prevLevel = null;

    for (var i = 0; i <= maxIndex; i++) {
      if (!byIndex[i] || !byIndex[i].length) continue;
      var level = sortLevel(byIndex[i], prevLevel);

      html +=
        '<div class="chain-level" data-height="' +
        i +
        '" style="display:flex;justify-content:center;flex-wrap:wrap;gap:16px;align-items:flex-start;margin:0 0 4px 0;">';

      for (var li = 0; li < level.length; li++) {
        var block = level[li];
        var isMain = !!mainHashes[block.hash];
        var panelClass = isMain ? (i === maxIndex ? 'panel-success' : 'panel-primary') : 'panel-warning';
        var label = isMain ? '' : '<span class="label label-warning pull-right">ORPHAN</span>';
        var forkId = block.forkId && block.forkId !== 'classic' ? String(block.forkId) : '';
        var forkBadge = forkId
          ? '<span class="label label-info pull-right" style="margin-right:5px;">' +
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
          for (var t = 0; t < block.transactions.length; t++) {
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
          txHtml += '</tbody></table></div>';
        }

        var minerId = block.miner != null ? block.miner : '';
        var hashShort = String(block.hash || '').substring(0, 16);
        var prevShort = String(block.previousHash || '').substring(0, 16);
        var timeStr = block.timestamp ? new Date(block.timestamp).toLocaleTimeString() : '';

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
          '" style="display:flex;flex-direction:column;align-items:center;width:300px;max-width:100%;">';
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
          '<dl class="dl-horizontal" style="margin-bottom:0;">' +
          '<dt style="width:80px;">Hash</dt><dd style="margin-left:90px;"><code style="font-size:10px;word-break:break-all;">' +
          escapeHtml(hashShort) +
          '…</code></dd>' +
          '<dt style="width:80px;">Prev</dt><dd style="margin-left:90px;"><code style="font-size:10px;word-break:break-all;">' +
          escapeHtml(prevShort) +
          '…</code></dd>' +
          '<dt style="width:80px;">Miner</dt><dd style="margin-left:90px;">' +
          fmtAddr(minerId) +
          '</dd>' +
          '<dt style="width:80px;">Nonce</dt><dd style="margin-left:90px;">' +
          escapeHtml(block.nonce) +
          '</dd>' +
          '<dt style="width:80px;">Txs</dt><dd style="margin-left:90px;">' +
          txHtml +
          '</dd>' +
          '</dl></div></div>';

        // Single down-arrow under this card only if it has children (no multi-angle fan)
        if (childCount > 0) {
          var arrowColor = hasOrphanChild || !isMain ? '#f0ad4e' : '#9e9e9e';
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

  window.ChainDisplay = {
    escapeHtml: escapeHtml,
    buildParticipantNameLookup: buildParticipantNameLookup,
    formatChainParticipantHtml: formatChainParticipantHtml,
    renderChainHtml: renderChainHtml
  };
})(typeof window !== 'undefined' ? window : this);
