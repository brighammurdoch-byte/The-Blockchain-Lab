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

  function buildParticipantNameLookup(participants) {
    var map = Object.create(null);
    if (!participants || !participants.length) return map;
    for (var i = 0; i < participants.length; i++) {
      var p = participants[i];
      if (p && p.address) {
        map[p.address] = p.name ? String(p.name).trim() : '';
      }
    }
    return map;
  }

  /**
   * Renders optional display name, full address (wraps when narrow), and copy control.
   * @param {string} address miner or wallet id
   * @param {Record<string,string>} nameLookup address -> display name
   */
  function formatChainParticipantHtml(address, nameLookup) {
    var addr = address == null ? '' : String(address);
    if (!addr) return '<span class="text-muted">—</span>';
    var isSystem = addr === 'system';
    var nm = !isSystem && nameLookup && nameLookup[addr] ? String(nameLookup[addr]).trim() : '';
    var bits = [];
    if (nm) {
      bits.push(
        '<div class="chain-node-name text-muted" style="font-size:12px;line-height:1.25;margin-bottom:4px;"><strong>' +
          escapeHtml(nm) +
          '</strong></div>'
      );
    }
    var copyBtn = '';
    if (!isSystem) {
      copyBtn =
        '<button type="button" class="btn btn-xs btn-default copy-btn" data-clipboard-text="' +
        escapeAttr(addr) +
        '" title="Copy address" aria-label="Copy address"><i class="glyphicon glyphicon-copy"></i></button>';
    }
    bits.push(
      '<div class="chain-id-row" style="display:flex;align-items:flex-start;gap:6px;justify-content:space-between;">' +
        '<code class="chain-address-full" style="font-size:11px;word-break:break-all;flex:1;min-width:0;margin:0;">' +
        escapeHtml(addr) +
        '</code>' +
        copyBtn +
        '</div>'
    );
    return bits.join('');
  }

  window.ChainDisplay = {
    escapeHtml: escapeHtml,
    buildParticipantNameLookup: buildParticipantNameLookup,
    formatChainParticipantHtml: formatChainParticipantHtml
  };
})(typeof window !== 'undefined' ? window : this);
