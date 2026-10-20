// Which Chrome is installed, and which devtools-frontend commit goes with it.
//
// The frontend must match the browser: DevTools talks CDP to its own host, and a
// mismatch shows up as missing host APIs or panels that silently don't render.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';

const CANDIDATES = [
  // macos
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--version']],
  ['/Applications/Chromium.app/Contents/MacOS/Chromium', ['--version']],
  ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', ['--version']],
  // linux
  ['google-chrome', ['--version']],
  ['google-chrome-stable', ['--version']],
  ['chromium', ['--version']],
];

export function detectBrowser() {
  for (const [bin, args] of CANDIDATES) {
    try {
      const out = execFileSync(bin, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
      const m = /(\d+\.\d+\.\d+\.\d+)/.exec(out);
      if (m) return {bin, version: m[1], milestone: Number(m[1].split('.')[0]), raw: out};
    } catch { /* not installed */ }
  }
  return null;
}

/** chromiumdash gives the exact devtools-frontend hash Chrome shipped with. */
export async function resolveFrontend(version) {
  const url = `https://chromiumdash.appspot.com/fetch_version?version=${encodeURIComponent(version)}`;
  const res = await fetch(url, {signal: AbortSignal.timeout(20000)});
  if (!res.ok) throw new Error(`chromiumdash ${res.status} for ${version}`);
  const json = await res.json();
  const rev = json?.hashes?.devtools;
  if (!rev) throw new Error(`no devtools hash in chromiumdash response for ${version}`);
  return {revision: rev, milestone: json.milestone ?? null, position: json.chromium_main_branch_position ?? null};
}

/** A build for this Chrome, if one is already cached. */
export function cachedFrontend(cacheDir, version) {
  const dir = `${cacheDir}/${version}/front_end`;
  return fs.existsSync(`${dir}/devtools_app.html`) ? dir : null;
}
