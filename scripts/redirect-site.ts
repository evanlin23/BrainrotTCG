/**
 * The old address, once the site has moved (docs/HOSTING.md). Every page there sends people to the
 * same place at the new address. A save lives in the storage of the address it was made on, so a
 * player who has one here is first offered to bring it: one tap opens the new address in a small
 * window, and the two pages hand the save over with postMessage, each checking the other's origin
 * (src/game/move.ts). It never goes in a URL. The new address's Save & restore can also ask for it, by
 * opening this page at #/send.
 *
 *   npx tsx scripts/redirect-site.ts <new-url> <out-dir>     (deploy, when the site lives elsewhere)
 *
 * Writes index.html and 404.html (GitHub Pages serves 404.html for every other path) and copies
 * hall-of-fame.json, which the Hall of Fame scripts read from the old address.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const [newUrl, outDir] = process.argv.slice(2);
if (!/^https?:\/\//.test(newUrl ?? '') || !newUrl.endsWith('/') || !outDir) {
  console.error('Usage: npx tsx scripts/redirect-site.ts https://new.example/ <out-dir>');
  process.exit(2);
}
const OLD_BASE = process.env.OLD_BASE_PATH ?? '/BrainrotTCG/';
const shortName = newUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');

// Plain ES2017, so it runs on anything that could have run the game.
const script = `(function () {
  var NEW = ${JSON.stringify(newUrl)}, NEW_ORIGIN = new URL(NEW).origin, BASE = ${JSON.stringify(OLD_BASE)};
  var MOVED = 'brainrot-moved-v1';
  var path = location.pathname.indexOf(BASE) === 0 ? location.pathname.slice(BASE.length) : '';
  if (path === 'index.html' || path === '404.html') path = '';
  // Only links worth following are passed on.
  var hash = /^#\\/(pull|profile)\\//.test(location.hash) ? location.hash : '';
  var go = function () { location.replace(NEW + path + hash); };
  var status = document.getElementById('status');

  var save = {}, has = false;
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && key.indexOf('brainrot-') === 0 && key !== MOVED && key !== 'brainrot-reopened-v1') { save[key] = localStorage.getItem(key); has = true; }
    }
  } catch (e) {}
  var markMoved = function () { try { localStorage.setItem(MOVED, new Date().toISOString()); } catch (e) {} };

  // Asked by the new address's Save & restore: send the save to the window that opened this one (which
  // closes this one straight away). Old links then go straight through.
  if (location.hash === '#/send' && window.opener) {
    window.opener.postMessage(has ? { type: 'brainrot-save', save: save } : { type: 'brainrot-no-save' }, NEW_ORIGIN);
    if (has) markMoved();
    status.textContent = has ? 'Sent to ' + ${JSON.stringify(shortName)} + '. You can close this window.' : 'There is no save here.';
    return;
  }

  // Nothing to bring, or already brought: straight on.
  var moved = false;
  try { moved = !!localStorage.getItem(MOVED); } catch (e) {}
  if (!has || moved) return go();

  document.getElementById('choice').hidden = false;
  document.getElementById('skip').onclick = go;
  document.getElementById('bring').onclick = function () {
    var popup = window.open(NEW + '#/receive', 'brainrot-receive', 'popup,width=440,height=360');
    if (!popup) { status.textContent = 'Your browser blocked the window. Allow pop-ups for this page, then tap again.'; return; }
    status.textContent = 'Bringing your save over…';
    window.addEventListener('message', function (e) {
      if (e.origin !== NEW_ORIGIN || e.source !== popup || !e.data) return;
      if (e.data.type === 'brainrot-ready') popup.postMessage({ type: 'brainrot-save', save: save }, NEW_ORIGIN);
      if (e.data.type === 'brainrot-move-result') {
        if (e.data.result === 'saved' || e.data.result === 'same') markMoved();
        go();
      }
    });
  };
})();`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Brainrot TCG has moved</title>
<link rel="canonical" href="${newUrl}">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121114;color:#f2efe9;font:17px/1.5 system-ui,sans-serif;padding:24px;box-sizing:border-box}
main{max-width:26rem;text-align:center}
h1{font-size:1.6rem;margin:0 0 .5rem}
a{color:#ffd23f}
button{display:block;width:100%;margin:.75rem 0 0;padding:.85rem 1rem;border-radius:10px;font:600 1rem system-ui,sans-serif;cursor:pointer}
#bring{background:#ffd23f;color:#121114;border:0}
#skip{background:none;color:#f2efe9;border:1px solid #4a454f}
#status{min-height:1.5em;color:#b6b0ba}
</style>
</head>
<body>
<main>
<h1>Brainrot TCG has moved</h1>
<p>It now lives at <a href="${newUrl}">${shortName}</a>.</p>
<div id="choice" hidden>
<p>Your save (cards, packs and player key) is stored at this old address. Bring it along?</p>
<button type="button" id="bring">Bring my save and go</button>
<button type="button" id="skip">Go without it</button>
</div>
<p id="status" role="status"></p>
</main>
<script>${script}</script>
</body>
</html>
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/index.html`, page);
writeFileSync(`${outDir}/404.html`, page);
const hof = `${ROOT}dist/hall-of-fame.json`;
if (existsSync(hof)) copyFileSync(hof, `${outDir}/hall-of-fame.json`);
console.log(`${outDir}: redirects to ${newUrl}`);
