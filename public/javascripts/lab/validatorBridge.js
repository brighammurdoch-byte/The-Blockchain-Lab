/**
 * Shared classroom validator compile + live apply.
 * Standalone editor and miner tab both use this so Submit actually
 * changes the node that mines and validates blocks.
 */
(function (global) {
  var CHANNEL = 'blockchain-lab-validator';
  var KEY_GLOBAL = 'labValidatorCode';
  var KEY_PREFIX = 'labValidatorCode_';
  var channel = null;

  function sessionKey(sessionId) {
    return sessionId ? (KEY_PREFIX + String(sessionId).toUpperCase()) : KEY_GLOBAL;
  }

  function normalize(code) {
    if (typeof code === 'string') return code;
    if (code && typeof code === 'object' && typeof code.value === 'string') return code.value;
    return '';
  }

  function compile(code, originalCode) {
    code = normalize(code);
    if (code.includes('WALLET DOUBLE SPEND SCRIPT')) {
      return { ok: true, skip: true, isCustom: false };
    }
    if (!code.trim()) {
      return { ok: true, empty: true, isCustom: false };
    }
    try {
      var browserCode = code
        .replace(/const crypto = require\(['"]crypto['"]\);/g, [
          'const crypto = {',
          '  createHash: function() {',
          '    return {',
          '      data: "",',
          '      update: function(d) { this.data += (typeof d === "string" ? d : JSON.stringify(d)); return this; },',
          '      digest: function() { return window.sha256(this.data); }',
          '    };',
          '  }',
          '};'
        ].join('\n'))
        .replace(/module\.exports\s*=\s*BlockValidator;?/g, '')
        + '\nreturn new BlockValidator();';
      var validator = new Function(browserCode)();
      var orig = (typeof originalCode === 'string') ? originalCode.trim() : '';
      return {
        ok: true,
        validator: validator,
        isCustom: !!(orig && code.trim() !== orig)
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  function applyToWindow(code, originalCode) {
    var result = compile(code, originalCode);
    if (result.skip) return result;
    if (result.empty) {
      try { delete global.customValidator; } catch (e) { global.customValidator = null; }
      global.__labValidatorIsCustom = false;
      return result;
    }
    if (!result.ok) return result;
    global.customValidator = result.validator;
    global.__labValidatorIsCustom = !!result.isCustom;
    return result;
  }

  function save(sessionId, code) {
    code = normalize(code);
    try {
      global.localStorage.setItem(KEY_GLOBAL, code);
      if (sessionId) global.localStorage.setItem(sessionKey(sessionId), code);
    } catch (e) {}
    publish({ type: 'apply', sessionId: sessionId ? String(sessionId).toUpperCase() : '', code: code });
  }

  function load(sessionId) {
    try {
      if (sessionId) {
        var scoped = global.localStorage.getItem(sessionKey(sessionId));
        if (scoped) return scoped;
      }
      return global.localStorage.getItem(KEY_GLOBAL) || '';
    } catch (e) {
      return '';
    }
  }

  function clear(sessionId) {
    try {
      global.localStorage.removeItem(KEY_GLOBAL);
      if (sessionId) global.localStorage.removeItem(sessionKey(sessionId));
    } catch (e) {}
    publish({ type: 'reset', sessionId: sessionId ? String(sessionId).toUpperCase() : '' });
  }

  function getChannel() {
    if (channel || typeof global.BroadcastChannel === 'undefined') return channel;
    try { channel = new global.BroadcastChannel(CHANNEL); } catch (e) { channel = null; }
    return channel;
  }

  function publish(msg) {
    var ch = getChannel();
    if (ch) {
      try { ch.postMessage(msg); } catch (e) {}
    }
    try {
      global.localStorage.setItem('labValidatorPing', String(Date.now()) + ':' + (msg.type || ''));
    } catch (e) {}
  }

  function listen(handler) {
    var ch = getChannel();
    if (ch) {
      ch.addEventListener('message', function (ev) {
        if (ev && ev.data) handler(ev.data);
      });
    }
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('storage', function (ev) {
        if (!ev || ev.key !== KEY_GLOBAL) return;
        handler({ type: ev.newValue ? 'apply' : 'reset', sessionId: '', code: ev.newValue || '' });
      });
    }
  }

  global.ValidatorBridge = {
    compile: compile,
    applyToWindow: applyToWindow,
    save: save,
    load: load,
    clear: clear,
    listen: listen,
    normalize: normalize
  };
})(typeof window !== 'undefined' ? window : globalThis);
