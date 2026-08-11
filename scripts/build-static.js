/**
 * Build a static site for GitHub Pages into docs/
 *
 * Usage:
 *   node scripts/build-static.js
 *   LAB_BASE_PATH=/The-Blockchain-Lab node scripts/build-static.js
 */
const fs = require('fs');
const path = require('path');
const pug = require('pug');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'views');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'docs');
const BASE = (process.env.LAB_BASE_PATH || '/The-Blockchain-Lab').replace(/\/$/, '');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function rewriteAssetPaths(html) {
  // Prefix absolute site paths with GitHub Pages base
  return html
    .replace(/(src|href)=["']\/(?!\/)/g, `$1="${BASE}/`)
    .replace(/url\(['"]?\/(?!\/)/g, `url('${BASE}/`);
}

function renderLabPage(viewRelative, locals) {
  const file = path.join(VIEWS, viewRelative);
  const html = pug.renderFile(file, Object.assign({
    title: 'Blockchain Lab',
    sessionId: '',
    bodyClass: 'lab-app',
    __: (s) => s,
    basedir: VIEWS
  }, locals));
  const boot = `<script>window.LAB_STATIC_MODE=true;window.LAB_BASE_PATH=${JSON.stringify(BASE)};document.documentElement.setAttribute('data-lab-static','true');</script>`;
  const meta = `<meta name="lab-base-path" content="${BASE}">`;
  let out = html.replace('<head>', `<head>\n    ${meta}\n    ${boot}`);
  out = rewriteAssetPaths(out);
  // Navbar brand should point at lab index
  out = out.replace(`href="${BASE}/lab"`, `href="${BASE}/lab/index.html"`);
  return out;
}

function writeFile(rel, content) {
  const full = path.join(OUT, rel);
  ensureDir(path.dirname(full));
  fs.writeFileSync(full, content, 'utf8');
  console.log('wrote', rel);
}

function main() {
  // Clean docs (keep .nojekyll)
  if (fs.existsSync(OUT)) {
    for (const entry of fs.readdirSync(OUT)) {
      if (entry === '.git') continue;
      fs.rmSync(path.join(OUT, entry), { recursive: true, force: true });
    }
  } else {
    ensureDir(OUT);
  }

  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  copyDir(PUBLIC, path.join(OUT));

  // Ensure validator JSON exists in public/data (copied above)
  const validatorSrc = path.join(ROOT, 'lib', 'blockValidator.js');
  const validatorJson = {
    success: true,
    filename: 'blockValidator.js',
    code: fs.readFileSync(validatorSrc, 'utf8'),
    description: 'Client-side validator for Blockchain Lab (static asset).'
  };
  writeFile('data/validator-code.json', JSON.stringify(validatorJson));
  writeFile('data/demos.json', JSON.stringify({
    success: true,
    demos: [
      { id: 'soft-fork', title: 'Soft Fork Demo', category: 'soft-fork', difficulty: 'intermediate' },
      { id: 'hard-fork', title: 'Hard Fork Demo', category: 'hard-fork', difficulty: 'advanced' },
      { id: '51-attack', title: '51% Attack Simulation', category: 'attack', difficulty: 'advanced' },
      { id: 'double-spend', title: 'Double Spend via Fork', category: 'attack', difficulty: 'advanced' }
    ]
  }));

  writeFile('lab/index.html', renderLabPage('lab/index.pug', { title: 'Blockchain Lab' }));
  writeFile('lab/admin.html', renderLabPage('lab/admin.pug', { title: 'Blockchain Lab - Admin', sessionId: '' }));
  writeFile('lab/participate.html', renderLabPage('lab/participate.pug', { title: 'Blockchain Lab - Miner', sessionId: '' }));
  writeFile('lab/observe.html', renderLabPage('lab/observe.pug', { title: 'Blockchain Lab - Wallet', sessionId: '' }));
  writeFile('lab/demos.html', renderLabPage('lab/demos.pug', { title: 'Blockchain Lab - Guided Demos', sessionId: '' }));
  writeFile('lab/code.html', renderLabPage('lab/code-editor.pug', { title: 'Blockchain Lab - Code Editor', sessionId: '' }));

  // Root redirect into the lab
  writeFile('index.html', `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=${BASE}/lab/index.html">
  <script>location.replace(${JSON.stringify(BASE + '/lab/index.html')});</script>
  <title>The Blockchain Lab</title>
</head>
<body>
  <p>Open <a href="${BASE}/lab/index.html">The Blockchain Lab</a>.</p>
</body>
</html>
`);

  // GitHub Pages config hint
  writeFile('CNAME.example', '# Optional: rename to CNAME with your custom domain\n');

  console.log('\\nStatic site built to docs/ with BASE_PATH=' + BASE);
  console.log('Enable GitHub Pages: Settings → Pages → Deploy from branch → /docs');
}

main();
