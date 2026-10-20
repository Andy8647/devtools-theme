#!/usr/bin/env node
// devtools-theme — build a Chrome DevTools frontend that matches your browser,
// then theme it. Chrome removed the old theming API in 2024, so this is the only
// path left: compile the frontend yourself and point Chrome at it with
// --custom-devtools-frontend.
//
//   dtfe doctor                  what Chrome is installed, which frontend it needs
//   dtfe build [--dry-run]       compile + cache that frontend (~10 min, 3 GB)
//   dtfe themes                  list bundled themes
//   dtfe render <theme> [-o f]   just emit the CSS (no build needed)
//   dtfe serve  [--theme x]      serve it; --open launches Chrome with the flag
//   dtfe launch [--theme x]      serve in the background + open Chrome
//
// Themes are ~24 colours per variant; the engine derives the 250-tone palette.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {detectBrowser, resolveFrontend, cachedFrontend} from '../lib/chrome.mjs';
import {buildFrontend} from '../lib/build.mjs';
import {renderTheme} from '../lib/theme.mjs';
import {startServer, launchBrowser, isChromeRunning} from '../lib/serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const cacheDir = process.env.DEVTOOLS_THEME_CACHE
  ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'devtools-theme');
const stateDir = path.join(cacheDir, 'state');

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = name => argv.includes(`--${name}`);

const pad = (s, n) => String(s).padEnd(n);
const die = (msg, code = 1) => { console.error(`dtfe: ${msg}`); process.exit(code); };

function loadTheme(nameOrPath) {
  const p = fs.existsSync(nameOrPath) ? nameOrPath : path.join(pkgRoot, 'themes', `${nameOrPath}.json`);
  if (!fs.existsSync(p)) {
    const names = fs.readdirSync(path.join(pkgRoot, 'themes')).map(f => f.replace(/\.json$/, ''));
    die(`no theme "${nameOrPath}". bundled: ${names.join(', ')}`);
  }
  const theme = JSON.parse(fs.readFileSync(p, 'utf8'));
  return {theme, file: p, name: theme.name ?? path.basename(p, '.json')};
}

function writeThemeCss(nameOrPath) {
  const {theme, file, name} = loadTheme(nameOrPath);
  const css = renderTheme(theme);
  fs.mkdirSync(stateDir, {recursive: true});
  const out = path.join(stateDir, 'theme.css');
  fs.writeFileSync(out, `/* ${name} (${path.relative(pkgRoot, file)}) */\n${css}`);
  return {out, name, css, file};
}

async function resolveAll({requireCache = true} = {}) {
  const browser = detectBrowser();
  if (!browser) die('no Chrome/Chromium/Edge found');
  const frontend = cachedFrontend(cacheDir, browser.version);
  let remote = null;
  try { remote = await resolveFrontend(browser.version); } catch (e) { remote = {error: e.message}; }
  if (!frontend && requireCache) {
    die(`no frontend build for Chrome ${browser.version} yet — run: dtfe build\n` +
        `  (cache: ${cacheDir}/${browser.version}/front_end)`);
  }
  return {browser, frontend, remote};
}

async function main() {
  switch (cmd) {
    case 'doctor': {
      const {browser, frontend, remote} = await resolveAll({requireCache: false});
      console.log(`${pad('chrome', 10)} ${browser.version}  (${browser.bin})`);
      console.log(`${pad('frontend', 10)} ${remote.error ?? remote.revision}`);
      console.log(`${pad('cache', 10)} ${frontend ?? '— (run dtfe build)'}`);
      console.log(`${pad('cache dir', 10)} ${cacheDir}`);
      const themeList = fs.readdirSync(path.join(pkgRoot, 'themes')).map(f => f.replace(/\.json$/, ''));
      console.log(`${pad('themes', 10)} ${themeList.join(', ')}`);
      if (frontend && !remote.error) {
        const marker = path.join(path.dirname(frontend), '.frontend-revision');
        const built = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '(unknown)';
        if (built !== '(unknown)' && built !== remote.revision) {
          console.log(`warning: cached build is ${built}, Chrome ${browser.version} wants ${remote.revision}`);
        }
      }
      return;
    }

    case 'build': {
      const {browser, frontend, remote} = await resolveAll({requireCache: false});
      if (frontend) { console.log(`already built: ${frontend}`); return; }
      if (remote.error) die(`cannot resolve frontend for ${browser.version}: ${remote.error}`);
      const out = await buildFrontend({
        version: browser.version, revision: remote.revision, cacheDir,
        dryRun: has('dry-run'), keepSrc: has('keep-src'), jobs: Number(flag('jobs', 8)),
      });
      if (!has('dry-run')) {
        fs.writeFileSync(path.join(path.dirname(out), '.frontend-revision'), `${remote.revision}\n`);
        console.log(`\nnext: dtfe serve --theme catppuccin --open`);
      }
      return;
    }

    case 'themes': {
      for (const f of fs.readdirSync(path.join(pkgRoot, 'themes')).sort()) {
        const t = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'themes', f), 'utf8'));
        console.log(`${pad(path.basename(f, '.json'), 14)} ${t.name ?? ''}`);
      }
      return;
    }

    case 'render': {
      const nameOrPath = argv[1] && !argv[1].startsWith('--') ? argv[1] : flag('theme', 'catppuccin');
      const {css, name} = writeThemeCss(nameOrPath);
      const out = flag('out', null);
      if (out && out !== true) { fs.writeFileSync(out, css); console.log(`wrote ${out}`); }
      else process.stdout.write(css);
      console.error(`(${name})`);
      return;
    }

    case 'serve':
    case 'launch': {
      const themeName = flag('theme', 'catppuccin');
      const {out, name, file} = writeThemeCss(themeName);
      const {browser, frontend} = await resolveAll();
      const port = Number(flag('port', 8066));
      // render from the theme source on every request: edit the JSON, reopen DevTools
      const rerender = () => renderTheme(JSON.parse(fs.readFileSync(file, 'utf8')));
      const {url} = await startServer({frontend, themeCss: rerender, port});
      console.log(`theme   ${name}  (${path.relative(pkgRoot, file)}, live)`);
      console.log(`        cached copy ${out}`);
      console.log(`chrome  ${browser.version}`);
      console.log(`serving ${url}`);
      const open = cmd === 'launch' || has('open');
      if (open) {
        if (isChromeRunning()) {
          console.log('note: Chrome is already running and ignores the flag — quit it first,');
          console.log('      then: open -na "Google Chrome" --args --custom-devtools-frontend=' + url);
        }
        console.log(await launchBrowser(url, {dryRun: has('dry-run')}));
      }
      return; // server keeps the process alive
    }

    default:
      console.log(`devtools-theme — theme Chrome DevTools by building its frontend

  dtfe doctor                    what Chrome you have, which frontend it needs
  dtfe build [--dry-run] [--jobs N] [--keep-src]
  dtfe themes
  dtfe render <theme> [-o file]
  dtfe serve  [--theme NAME] [--port N] [--open]
  dtfe launch [--theme NAME] [--port N]

cache: ${cacheDir}
env:   DEVTOOLS_THEME_CACHE, CHROME (linux binary), XDG_CACHE_HOME
`);
      if (cmd) process.exitCode = 2;
  }
}

await main();
