/**
 * Lab URL helpers — work under Express (/lab/...) and GitHub Pages (/BASE/lab/...).
 */
(function (global) {
  function getBasePath() {
    if (typeof global.LAB_BASE_PATH === 'string') {
      return global.LAB_BASE_PATH.replace(/\/$/, '');
    }
    var meta = typeof document !== 'undefined'
      ? document.querySelector('meta[name="lab-base-path"]')
      : null;
    if (meta && meta.content) {
      return String(meta.content).replace(/\/$/, '');
    }
    // Infer from /lab/ in the current path (project Pages: /The-Blockchain-Lab/lab/...)
    var path = (global.location && global.location.pathname) || '';
    var idx = path.indexOf('/lab/');
    if (idx > 0) return path.slice(0, idx);
    if (path.endsWith('/lab') || path.endsWith('/lab/index.html')) {
      return path.replace(/\/lab\/?$/, '').replace(/\/index\.html$/, '');
    }
    return '';
  }

  function getSessionIdFromLocation() {
    var params = new URLSearchParams((global.location && global.location.search) || '');
    var q = params.get('join') || params.get('session') || params.get('code');
    if (q) return q.trim().toUpperCase();

    var path = (global.location && global.location.pathname) || '';
    // /lab/admin/ABC123 or /lab/admin.html
    var parts = path.split('/').filter(Boolean);
    var last = parts[parts.length - 1] || '';
    if (last && !/\.html?$/i.test(last) && last.toLowerCase() !== 'lab') {
      return last.toUpperCase();
    }
    return '';
  }

  function isStaticMode() {
    return !!(global.LAB_STATIC_MODE ||
      (typeof document !== 'undefined' && document.documentElement &&
        document.documentElement.getAttribute('data-lab-static') === 'true'));
  }

  /**
   * @param {'index'|'admin'|'participate'|'observe'|'demos'|'code'} page
   * @param {string} [sessionId]
   */
  function labUrl(page, sessionId) {
    var base = getBasePath();
    var code = sessionId ? String(sessionId).toUpperCase() : '';
    var staticMode = isStaticMode();

    if (staticMode) {
      var file = page === 'index' ? 'index.html' : (page + '.html');
      var url = base + '/lab/' + file;
      if (code && page === 'index') {
        url += '?join=' + encodeURIComponent(code);
      } else if (code && page !== 'demos') {
        url += '?session=' + encodeURIComponent(code);
      }
      return url;
    }

    if (page === 'index') {
      return base + '/lab' + (code ? ('?join=' + encodeURIComponent(code)) : '');
    }
    if (page === 'demos') return base + '/lab/demos' + (code ? '/' + code : '');
    return base + '/lab/' + page + (code ? '/' + code : '');
  }

  /** Path or site-relative join link for students (landing with code pre-filled). */
  function joinUrl(sessionId) {
    return labUrl('index', sessionId);
  }

  /** Absolute https://… join URL for QR codes and sharing. */
  function absoluteJoinUrl(sessionId) {
    var path = joinUrl(sessionId);
    if (/^https?:\/\//i.test(path)) return path;
    var origin = (global.location && global.location.origin) ? global.location.origin : '';
    return origin + path;
  }

  function assetUrl(path) {
    var base = getBasePath();
    if (!path) return base + '/';
    if (path.charAt(0) !== '/') path = '/' + path;
    return base + path;
  }

  global.LabPaths = {
    getBasePath: getBasePath,
    getSessionIdFromLocation: getSessionIdFromLocation,
    labUrl: labUrl,
    joinUrl: joinUrl,
    absoluteJoinUrl: absoluteJoinUrl,
    assetUrl: assetUrl
  };
})(typeof window !== 'undefined' ? window : globalThis);
