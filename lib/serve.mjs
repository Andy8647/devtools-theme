// Static server for the frontend, with the theme injected into the token sheet.
// The CSS is re-read on every request, so tweaking a theme only needs a DevTools
// reload (Cmd+Opt+I twice), not a server restart.

import http from 'node:http';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function startServer({frontend, themeCss, port = 8066, host = '127.0.0.1'}) {
  // themeCss is either a path or a function returning CSS, so a serve process can
  // re-render the theme from its source on every request.
  const root = fs.realpathSync(frontend);
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.join(root, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, {'Content-Type': 'text/plain'}).end(`not found: ${urlPath}`);
        return;
      }
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      let body = data;
      if (path.basename(file) === 'design_system_tokens.css') {
        let css = '';
        try {
          css = typeof themeCss === 'function' ? themeCss() : fs.readFileSync(themeCss, 'utf8');
        } catch (e) {
          css = `/* devtools-theme: ${e.message} */`;
        }
        body = Buffer.concat([data, Buffer.from(`\n\n/* devtools-theme */\n${css}`)]);
      }
      res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-store'});
      res.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({server, url: `http://${host}:${port}/`}));
  });
}

/** Try to open a Chrome that consumes that URL. A running Chrome ignores the flag. */
export async function launchBrowser(url, {platform = process.platform, dryRun = false} = {}) {
  const flag = `--custom-devtools-frontend=${url}`;
  if (platform === 'darwin') {
    const args = ['-na', 'Google Chrome', '--args', flag];
    if (dryRun) return `open ${args.join(' ')}`;
    spawnSync('open', args, {stdio: 'inherit'});
    return `open ${args.join(' ')}`;
  }
  const bin = process.env.CHROME ?? 'google-chrome';
  if (dryRun) return `${bin} ${flag}`;
  spawnSync(bin, [flag], {stdio: 'ignore', detached: true}).unref?.();
  return `${bin} ${flag}`;
}

export function isChromeRunning({platform = process.platform} = {}) {
  if (platform === 'darwin') return spawnSync('pgrep', ['-x', 'Google Chrome']).status === 0;
  return spawnSync('pgrep', ['-x', 'chrome']).status === 0;
}
