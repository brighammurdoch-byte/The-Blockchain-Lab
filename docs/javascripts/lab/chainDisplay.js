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

  window.ChainDisplay = {
    escapeHtml: escapeHtml,
    buildParticipantNameLookup: buildParticipantNameLookup,
    formatChainParticipantHtml: formatChainParticipantHtml
  };
})(typeof window !== 'undefined' ? window : this);
