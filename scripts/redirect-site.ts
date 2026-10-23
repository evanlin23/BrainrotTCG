/**
 * The old address, once the site has moved (docs/HOSTING.md). Every page there sends people to the
 * same place at the new address. A save lives in the storage of the address it was made on, so a
 * player who has one here is first offered to bring it: one tap opens the new address in a small
 * window, and the two pages hand the save over with postMessage, each checking the other's origin
 * (src/game/move.ts). It never goes in a URL. The new address's Save & backup can also ask for it, by
 * opening this page at #/send.
 *
 *   npx tsx scripts/redirect-site.ts <new-url> <out-dir>     (deploy, when the site lives elsewhere)
 *
 * Writes index.html and 404.html (GitHub Pages serves 404.html for every other path) and copies
 * hall-of-fame.json, the pulls of rejected issues and the rankings, which the Hall of Fame scripts read
 * from the old address.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ROUTE_HASH } from '../src/game/route.ts';
import { isMainModule } from './main-module.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const shortNameOf = (newUrl: string) => newUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');

/**
 * The script that sends a visit on, or first offers to bring its save. Plain ES2017, so it runs on
 * anything that could have run the game.
 */
export const redirectScript = (newUrl: string, oldBase: string) => `(function () {
  var NEW = ${JSON.stringify(newUrl)}, NEW_ORIGIN = new URL(NEW).origin, BASE = ${JSON.stringify(oldBase)};
  var MOVED = 'brainrot-moved-v1';
  var path = location.pathname.indexOf(BASE) === 0 ? location.pathname.slice(BASE.length) : '';
  if (path === 'index.html' || path === '404.html') path = '';
  // Only the app's own routes (src/game/route.ts) are passed on.
  var hash = ${String(ROUTE_HASH)}.test(location.hash) ? location.hash : '';
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

  // Asked by the new address's Save & backup: send the save to the window that opened this one (which
  // closes this one straight away). Sending isn't arriving: that window imports it only after this one
  // is gone, and the import can fail or be declined, so nothing here says the save moved (#1035). Old
  // links keep offering Bring, which marks it moved once the new address reports it stored.
  if (location.hash === '#/send' && window.opener) {
    window.opener.postMessage(has ? { type: 'brainrot-save', save: save } : { type: 'brainrot-no-save' }, NEW_ORIGIN);
    status.textContent = has ? 'Sent to ' + ${JSON.stringify(shortNameOf(newUrl))} + '. You can close this window.' : 'There is no save here.';
    return;
  }

  // Nothing to bring, or already brought: straight on.
  var moved = false;
  try { moved = !!localStorage.getItem(MOVED); } catch (e) {}
  if (!has || moved) return go();

  document.getElementById('choice').hidden = false;
  document.getElementById('skip').onclick = go;
  // A failed hand-over leaves the new address's window open with its note; tapping again opens the
  // same named window at #/receive, and it starts over (receiveSave).
  var popup = null, ready = false, bringTimer = null, onMessage = null;
  document.getElementById('bring').onclick = function () {
    clearTimeout(bringTimer);
    if (onMessage) window.removeEventListener('message', onMessage);
    // A window from the last tap that never said it was ready (still loading, or it gave up and
    // started the game) won't answer a fragment change: close it so this tap loads a fresh one.
    if (popup && !ready) { try { popup.close(); } catch (e) {} }
    ready = false;
    popup = window.open(NEW + '#/receive', 'brainrot-receive', 'popup,width=440,height=360');
    if (!popup) { status.textContent = 'Your browser blocked the window. Allow pop-ups for this page, then tap again.'; return; }
    status.textContent = 'Bringing your save over…';
    // Only until the new window says it's ready (then it may be asking the player); a late answer still counts.
    bringTimer = setTimeout(function () {
      status.textContent = "Transfer didn't finish. Tap to try again, or go without your save.";
    }, 15000);
    onMessage = function (e) {
      if (e.origin !== NEW_ORIGIN || e.source !== popup || !e.data) return;
      if (e.data.type === 'brainrot-ready') {
        ready = true;
        clearTimeout(bringTimer);
        status.textContent = 'Bringing your save over…';
        popup.postMessage({ type: 'brainrot-save', save: save }, NEW_ORIGIN);
      }
      if (e.data.type === 'brainrot-move-result') {
        clearTimeout(bringTimer);
        window.removeEventListener('message', onMessage);
        onMessage = null;
        if (e.data.result === 'saved' || e.data.result === 'same') markMoved();
        go();
      }
    };
    window.addEventListener('message', onMessage);
  };
})();`;

/** The page every address at the old base gets: index.html and 404.html. */
export const redirectPage = (newUrl: string, oldBase = '/BrainrotTCG/') => `<!doctype html>
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
<p>It now lives at <a href="${newUrl}">${shortNameOf(newUrl)}</a>.</p>
<div id="choice" hidden>
<p>Your save (cards, packs and player key) is stored at this old address. Bring it along?</p>
<button type="button" id="bring">Bring my save and go</button>
<button type="button" id="skip">Go without it</button>
</div>
<p id="status" role="status"></p>
</main>
<script>${redirectScript(newUrl, oldBase)}</script>
</body>
</html>
`;

/**
 * Copies what the Hall of Fame scripts read from the old address out of a build: hall-of-fame.json,
 * hall-of-fame-withdrawn.json (a build carries it forward from here when GitHub is down),
 * rankings.json and the rankings folder, those the build has. One the build didn't write isn't
 * copied, so the old address never serves a stale one.
 */
export const copyHallOfFame = (dist: string, outDir: string) => {
  for (const file of ['hall-of-fame.json', 'hall-of-fame-withdrawn.json', 'rankings.json', 'rankings']) {
    if (existsSync(`${dist}/${file}`)) cpSync(`${dist}/${file}`, `${outDir}/${file}`, { recursive: true });
  }
};

if (isMainModule(import.meta.url)) {
  const [newUrl, outDir] = process.argv.slice(2);
  if (!/^https?:\/\//.test(newUrl ?? '') || !newUrl.endsWith('/') || !outDir) {
    console.error('Usage: npx tsx scripts/redirect-site.ts https://new.example/ <out-dir>');
    process.exit(2);
  }
  const page = redirectPage(newUrl, process.env.OLD_BASE_PATH ?? '/BrainrotTCG/');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/index.html`, page);
  writeFileSync(`${outDir}/404.html`, page);
  copyHallOfFame(`${ROOT}dist`, outDir);
  console.log(`${outDir}: redirects to ${newUrl}`);
}
