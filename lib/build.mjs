// Build the DevTools frontend that matches the installed Chrome.
//
// The browser only ships *its own* bundled frontend (compiled into the binary /
// resources.pak), so "use a themed DevTools" means "compile the same frontend
// commit yourself and hand it to --custom-devtools-frontend". This is that
// compile, scripted: ~10 minutes, ~3 GB of scratch space, needs git, node,
// python3, ninja and Xcode command line tools (macOS) or build-essential (Linux).

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'https://github.com/ChromeDevTools/devtools-frontend.git';
const DEPOT_TOOLS = 'https://chromium.googlesource.com/chromium/tools/depot_tools.git';

const run = (cmd, args, opts = {}) => {
  const line = [cmd, ...args].join(' ');
  if (opts.dryRun) {
    console.log(`  $ ${line}${opts.cwd ? `   (in ${opts.cwd})` : ''}`);
    return '';
  }
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    stdio: opts.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {...process.env, ...(opts.env ?? {})},
    // gn/ninja control their own parallelism
    timeout: opts.timeout ?? 0,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${line} failed (${res.status})${opts.hint ? `\n  hint: ${opts.hint}` : ''}`);
  }
  return res.stdout ?? '';
};

const write = (file, text, dryRun) => {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, text);
};

// depot_tools puts a `ninja` wrapper first on PATH that needs its own bootstrap;
// prefer a real binary (gclient fetches one into third_party/ninja).
function findNinja(srcDir) {
  const fixed = [
    `${srcDir}/third_party/ninja/ninja`,
    `${srcDir}/third_party/ninja/ninja.exe`,
    '/opt/homebrew/bin/ninja',
    '/usr/local/bin/ninja',
    '/usr/bin/ninja',
  ];
  const found = fixed.find(p => fs.existsSync(p));
  if (found) return found;
  const viaPath = (process.env.PATH ?? '').split(':')
      .filter(d => !d.includes('depot_tools'))
      .map(d => `${d}/ninja`)
      .find(p => fs.existsSync(p));
  if (viaPath) return viaPath;
  throw new Error('no ninja found — install it (brew install ninja / apt install ninja-build)');
}

function gnPaths(srcDir) {
  const candidates = [
    `${srcDir}/buildtools/mac/gn`,
    `${srcDir}/buildtools/linux64/gn`,
    `${srcDir}/buildtools/win/gn.exe`,
  ];
  return candidates.find(p => fs.existsSync(p)) ?? 'gn';
}

/**
 * @param {{version: string, revision: string, cacheDir: string, dryRun?: boolean,
 *          keepSrc?: boolean, jobs?: number}} opts
 */
export async function buildFrontend(opts) {
  const {version, revision, cacheDir, dryRun = false} = opts;
  const work = `${cacheDir}/${version}`;
  const src = `${work}/src`;
  const out = `${src}/out/Default`;
  const depot = `${cacheDir}/depot_tools`;
  const target = `${work}/front_end`;

  if (fs.existsSync(`${target}/devtools_app.html`)) return target;

  if (!dryRun) fs.mkdirSync(work, {recursive: true});

  console.log(`\n== devtools-theme: building frontend for Chrome ${version}`);
  console.log(`   frontend commit ${revision}`);
  console.log(`   workdir ${work}`);

  // 1. exactly that commit, no history
  if (!fs.existsSync(`${src}/DEPS`)) {
    console.log('\n[1/7] fetching devtools-frontend');
    fs.mkdirSync(src, {recursive: true});
    run('git', ['init', '-q'], {cwd: src, dryRun});
    run('git', ['remote', 'add', 'origin', REPO], {cwd: src, dryRun});
    run('git', ['fetch', '-q', '--depth', '1', 'origin', revision], {cwd: src, dryRun});
    run('git', ['checkout', '-q', 'FETCH_HEAD'], {cwd: src, dryRun});
    run('git', ['checkout', '-q', '-B', 'theme', ], {cwd: src, dryRun});
  } else {
    console.log('\n[1/7] source tree already present');
  }

  // 2. gclient needs a solution file next to src/
  write(`${work}/.gclient`, `solutions = [{
  "name": "src",
  "url": "${REPO}",
  "deps_file": "DEPS",
  "managed": False,
  "custom_deps": {},
  "custom_vars": {},
}]
`, dryRun);

  // 3. depot_tools (shared by every version): provides vpython3/gn.py nesting
  if (!fs.existsSync(`${depot}/gclient`)) {
    console.log('\n[2/7] cloning depot_tools (shared)');
    run('git', ['clone', '-q', '--depth', '1', DEPOT_TOOLS, depot], {dryRun});
  } else {
    console.log('\n[2/7] depot_tools present');
  }
  const env = {PATH: `${depot}:${process.env.PATH}`, DEPOT_TOOLS_UPDATE: '0'};

  // 4. chromium's build/, buildtools/ and friends
  console.log('\n[3/7] gclient sync (downloads ~1.5 GB the first time)');
  run('gclient', ['sync', '-D', '--no-history', `-j${opts.jobs ?? 8}`],
      {cwd: work, env, dryRun, timeout: 0, hint: 'needs python3 and git; rerun if the network dropped'});

  // 5. node deps
  if (!fs.existsSync(`${src}/node_modules/typescript`)) {
    console.log('\n[4/7] npm ci');
    run('npm', ['ci'], {cwd: src, env, dryRun, quiet: true});
  } else {
    console.log('\n[4/7] node_modules present');
  }

  // 6. gn + ninja
  console.log('\n[5/7] gn gen');
  run(gnPaths(src), ['gen', out], {cwd: src, env, dryRun});
  console.log('\n[6/7] ninja (the long one)');
  run(dryRun ? 'ninja' : findNinja(src), ['-C', out], {cwd: src, env, dryRun, timeout: 0,
      hint: 'install ninja (brew install ninja / apt install ninja-build)'});

  // 7. prune and move into place
  console.log('\n[7/7] pruning + staging');
  const gen = `${out}/gen/front_end`;
  if (!dryRun) {
    if (!fs.existsSync(`${gen}/devtools_app.html`)) {
      throw new Error(`build finished but ${gen}/devtools_app.html is missing`);
    }
    const prune = [
      'legacy_test_runner', 'testing', 'test',
      'panels/timeline/fixtures', 'models/timeline/fixtures',
    ];
    for (const p of prune) fs.rmSync(`${gen}/${p}`, {recursive: true, force: true});
    const walk = dir => {
      for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const f = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(f);
        else if (/\.(d\.ts|js\.map)$/.test(e.name)) fs.rmSync(f, {force: true});
      }
    };
    walk(gen);
    fs.rmSync(target, {recursive: true, force: true});
    fs.renameSync(gen, target);
    if (!opts.keepSrc) fs.rmSync(src, {recursive: true, force: true});
  }
  console.log(`\n== done: ${target}`);
  return target;
}
