#!/usr/bin/env node
// build-plugin.mjs — 把 src/ 打包成 plugin/runtime/，讓 plugin 不需要建置就能發佈。
//
// 產物（都要進版本控制，使用者從 git 安裝時拿到的就是這些檔案）：
//   plugin/runtime/bot.mjs            src/main.ts 的單檔 bundle（npm 套件不打包，保留 import）
//   plugin/runtime/stop.mjs           src/stop.ts 的單檔 bundle
//   plugin/runtime/package.json       執行期依賴，版本釘死（取自根目錄 package-lock.json）
//   plugin/runtime/package-lock.json  依賴的完整鎖定檔，安裝時用 npm ci
//   plugin/runtime/version.json       plugin 版本＋產物 hash；setup／start 用來判斷要不要重新安裝
//
// npm 套件不打包進 bundle：Agent SDK 內建平台專屬的 CLI 執行檔（optionalDependencies），
// 只能由 npm 依平台安裝；其餘套件跟著一起裝，避免 bundle 與套件版本不一致。
// 用法：npm run build:plugin

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'plugin', 'runtime');
const PLUGIN_JSON = path.join(ROOT, 'plugin', '.claude-plugin', 'plugin.json');

// 執行期依賴：根目錄 package.json 的 dependencies，加上 Agent SDK 的 peerDependencies。
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).packages;
const sdkPeers = Object.keys(lock['node_modules/@anthropic-ai/claude-agent-sdk']?.peerDependencies ?? {});
const names = [...new Set([...Object.keys(rootPkg.dependencies ?? {}), ...sdkPeers])].sort();
const dependencies = {};
for (const name of names) {
  const v = lock[`node_modules/${name}`]?.version;
  if (!v) throw new Error(`package-lock.json 裡找不到 ${name}；請先在根目錄執行 npm install`);
  dependencies[name] = v;
}

fs.mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: { bot: path.join(ROOT, 'src', 'main.ts'), stop: path.join(ROOT, 'src', 'stop.ts') },
  outdir: OUT,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  legalComments: 'none',
  logLevel: 'warning',
});

const pluginVersion = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).version;
const runtimePkg = {
  name: 'channelcollab-runtime',
  version: pluginVersion,
  private: true,
  description: 'channelcollab Bot 的執行環境（由 scripts/build-plugin.mjs 產生，不要手動修改）',
  type: 'module',
  engines: { node: '>=22' },
  dependencies,
};
const pkgPath = path.join(OUT, 'package.json');
const lockPath = path.join(OUT, 'package-lock.json');
const oldPkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : null;
fs.writeFileSync(pkgPath, JSON.stringify(runtimePkg, null, 2) + '\n');

// 鎖定檔只在依賴變動時重產（需要連網），讓沒改依賴的建置結果保持一致。
if (!fs.existsSync(lockPath) || JSON.stringify(oldPkg?.dependencies) !== JSON.stringify(dependencies)) {
  console.log('依賴有變動，重新產生 package-lock.json…');
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  execFileSync(process.execPath, [npmCli, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: OUT,
    stdio: 'inherit',
  });
} else {
  // 只有 version 欄位跟著 plugin 版本變動時，同步改鎖定檔裡的版本，不必重新解析依賴。
  const l = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (l.version !== pluginVersion) {
    l.version = pluginVersion;
    if (l.packages?.['']) l.packages[''].version = pluginVersion;
    fs.writeFileSync(lockPath, JSON.stringify(l, null, 2) + '\n');
  }
}

const hash = createHash('sha256');
for (const f of ['bot.mjs', 'stop.mjs', 'package.json', 'package-lock.json']) hash.update(fs.readFileSync(path.join(OUT, f)));
const version = { version: pluginVersion, hash: hash.digest('hex').slice(0, 16) };
fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify(version, null, 2) + '\n');

console.log(`plugin/runtime 已更新：版本 ${version.version}，hash ${version.hash}`);
for (const [n, v] of Object.entries(dependencies)) console.log(`  ${n}@${v}`);
