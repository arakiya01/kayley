# アプリ内ワンクリック更新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kayleyデスクトップアプリに、GitHub Releasesの最新版をチェックし、ワンクリックでダウンロード・入れ替え・再起動する自前の更新機能を追加する。

**Architecture:** `electron-updater`（署名必須のSquirrel.Mac）は使わず、`electron/updater.js`という自前モジュールで「GitHub Releases APIをチェック→zipをダウンロード→OS標準コマンドで展開→現在のアプリ本体をリネームでバックアップしつつ新しいものと入れ替え→再起動」を行う。レンダラー側は`window.kayleyBridge`経由でチェック・適用の2つのIPCを呼ぶだけ。

**Tech Stack:** Electron 32のメインプロセス（Node標準の`fetch`・`child_process`・`fs`）。新しいnpm実行時依存は追加しない。macOSの`unzip`、Windowsの`powershell`（`Expand-Archive`）というOS標準コマンドをshelloutする。

**Spec:** このファイル自体が設計を兼ねる（ユーザーとのすり合わせ内容は下記Global Constraintsに集約）。関連: `docs/superpowers/plans/2026-08-27-local-file-storage.md`（preload/IPCの基盤はこのプランで作られたもの）。

## Global Constraints

- 署名・notarizeは行わない方針（確定済み）。ダウンロードした更新の真正性検証（署名チェック等）は今回のスコープ外。HTTPS＋GitHub自体の信頼性を前提にする。
- 新しいnpm実行時依存は追加しない。OS標準コマンド（macOS: `unzip`、Windows: `powershell`の`Expand-Archive`）のshelloutで済ませる。
- 検証用スクリプト（`verify_*.mjs`等）はリポジトリにコミットしないこと。
- 実際に「アプリを終了して入れ替えて再起動する」ところまでの実機最終確認は、Codexではなく私（Claude Code、別環境）が行う。Codexのサンドボックスは`.git`が読み取り専用でコミットもできない（過去のタスクと同じ運用）。
- `package.json`の`version`は現在`"0.0.0"`（GitHub Releaseのタグ`v0.0.0`と対応させてある）。

---

### Task 1: Windowsのビルドパイプラインを、Mac版と同じ「dir + 自前zip化」方式に揃える

**Files:**
- Modify: `package.json`
- Create: `scripts/package-win-zip.mjs`
- Modify: `README.md`

**Interfaces:**
- Produces: `npm run dist:win` が `dist/Kayley-{version}-win-x64-portable.zip` を生成する。zipの中身のトップレベルフォルダ名は`Kayley`（今までの`win-unpacked`から統一）。Task 3のダウンロード先アセット名と一致させる。

現状の`package.json`の該当箇所:
```json
    "dist:win": "electron-builder --win --publish=never",
```
```json
    "win": {
      "target": ["nsis"],
      "icon": "build/icon.ico",
      "signAndEditExecutable": false
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    }
```

現状の`scripts/package-mac-zips.mjs`（参考にする実装パターン。中身は変更しない）:
```js
import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync, chmodSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { path7za } from '7zip-bin';

const ROOT = path.join(import.meta.dirname, '..');
const pkg = JSON.parse(await import('node:fs').then((fs) => fs.promises.readFile(path.join(ROOT, 'package.json'), 'utf8')));
const productName = pkg.build.productName;
const version = pkg.version;
const helperScriptName = 'はじめにこれをダブルクリック.command';
const helperScriptSrc = path.join(ROOT, 'build', 'mac', helperScriptName);

const targets = [
  { dir: path.join(ROOT, 'dist', 'mac-arm64'), zipName: `${productName}-${version}-arm64-mac.zip` },
  { dir: path.join(ROOT, 'dist', 'mac'), zipName: `${productName}-${version}-mac.zip` },
];

for (const { dir, zipName } of targets) {
  const appPath = path.join(dir, `${productName}.app`);
  if (!existsSync(appPath)) { console.log(`skip: ${appPath} が無いのでこのアーキテクチャはビルドされていません`); continue; }
  const helperDest = path.join(dir, helperScriptName);
  copyFileSync(helperScriptSrc, helperDest);
  chmodSync(helperDest, 0o755);
  const zipPath = path.join(ROOT, 'dist', zipName);
  if (existsSync(zipPath)) unlinkSync(zipPath);
  execFileSync(path7za, ['a', '-tzip', '-mx=9', '-mcu', zipPath, `${productName}.app`, helperScriptName], { cwd: dir, stdio: 'inherit' });
  unlinkSync(helperDest);
  console.log(`作成しました: ${zipPath}`);
}
```

- [ ] **Step 1: `package.json`の`win.target`を`dir`に変更し、`nsis`設定ブロックを削除する**

```json
    "win": {
      "target": ["dir"],
      "icon": "build/icon.ico"
    },
```
（`nsis`ブロックと`signAndEditExecutable`は丸ごと削除。NSISは使わなくなるため。）

- [ ] **Step 2: `scripts/package-win-zip.mjs`を新規作成する**

`electron-builder --win dir --x64`の出力は`dist/win-unpacked/`という固定名のフォルダになる（アーキテクチャで名前が変わらない点がmacと違う）。中身をいったん`dist/Kayley/`という名前でコピーしてからzip化し、コピーは後片付けする。

```js
import { execFileSync } from 'node:child_process';
import { existsSync, cpSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { path7za } from '7zip-bin';

const ROOT = path.join(import.meta.dirname, '..');
const pkg = JSON.parse(await import('node:fs').then((fs) => fs.promises.readFile(path.join(ROOT, 'package.json'), 'utf8')));
const productName = pkg.build.productName;
const version = pkg.version;

const sourceDir = path.join(ROOT, 'dist', 'win-unpacked');
if (!existsSync(sourceDir)) {
  console.log(`skip: ${sourceDir} が無いのでWindows版はビルドされていません`);
  process.exit(0);
}

const stagingDir = path.join(ROOT, 'dist', productName);
rmSync(stagingDir, { recursive: true, force: true });
cpSync(sourceDir, stagingDir, { recursive: true });

const zipPath = path.join(ROOT, 'dist', `${productName}-${version}-win-x64-portable.zip`);
if (existsSync(zipPath)) unlinkSync(zipPath);

execFileSync(path7za, ['a', '-tzip', '-mx=9', '-mcu', zipPath, productName], { cwd: path.join(ROOT, 'dist'), stdio: 'inherit' });

rmSync(stagingDir, { recursive: true, force: true });
console.log(`作成しました: ${zipPath}`);
```

- [ ] **Step 3: `package.json`の`scripts.dist:win`を変更する**

```json
    "dist:win": "electron-builder --win dir --x64 --publish=never && node scripts/package-win-zip.mjs",
```

- [ ] **Step 4: 構文チェックとビルド実行**

```bash
node --check scripts/package-win-zip.mjs
npm run dist:win
```
Expected: `node --check`は出力無し。`npm run dist:win`は最後に`作成しました: .../dist/Kayley-0.0.0-win-x64-portable.zip`と表示され、正常終了する（このLinux環境でも`--win dir`はNSISを使わないため成功するはず。もし失敗したら、エラーメッセージをそのまま報告し、Task 4以降は進めてよい＝この失敗はTask 1のスコープの問題として切り分けて報告する）。

- [ ] **Step 5: 生成されたzipの中身を確認する**

```bash
python3 -c "
import zipfile
z = zipfile.ZipFile('dist/Kayley-0.0.0-win-x64-portable.zip')
names = z.namelist()
print('top-level entries sample:', [n for n in names if n.count('/') <= 1][:5])
print('has Kayley.exe:', any(n.endswith('Kayley/Kayley.exe') for n in names))
"
```
Expected: トップレベルが`Kayley/...`から始まる（`win-unpacked/...`ではない）こと、`Kayley/Kayley.exe`が存在すること。

- [ ] **Step 6: READMEのWindowsの案内を更新する**

`README.md`の以下の一文（現状）:
```
デスクトップ・スタートメニューへのショートカット付きの通常のインストーラー（`.exe` セットアップ）は、実際の Windows か GitHub Actions 等のx64環境でしか生成できない都合上、現状はこの「解凍して実行」形式のみです。
```
を、以下に置き換える:
```
デスクトップ・スタートメニューへのショートカット付きの通常のインストーラーは提供せず、この「解凍して実行」形式のポータブル版のみを配布します（アプリ内蔵の更新機能が、この形式のままアプリ本体を安全に入れ替えられる設計になっているため）。
```

- [ ] **Step 7: コミット**

```bash
git add package.json scripts/package-win-zip.mjs README.md
git commit -m "Windows版もdir+自前zip化方式に統一し、トップレベルフォルダ名をKayleyに揃える"
```

---

### Task 2: 更新チェック（GitHub Releases API・バージョン比較）

**Files:**
- Create: `electron/updater.js`
- Modify: `electron/main.js`
- Modify: `electron/preload.js`

**Interfaces:**
- Produces: `electron/updater.js`から`compareVersions(a, b): number`、`async checkForUpdate(currentVersion): Promise<{available, currentVersion, latestVersion, assetUrl, assetName, releaseUrl, error}>`をexportする。Task 3がこのファイルに追記する形で`applyUpdate`・`cleanupBackupIfPresent`を追加する。
- Produces: `window.kayleyBridge.checkForUpdate(): Promise<同上の戻り値>`（レンダラーから呼べる）。Task 4が消費する。

- [ ] **Step 1: `electron/updater.js`を新規作成する**

```js
// GitHub Releasesを使った自前の更新チェック・適用。
// electron-updater（Squirrel.Mac）は署名済みアプリを要求するため使わず、
// 「zipをダウンロード→展開→アプリ本体を入れ替え→再起動」を自前で行う。
const REPO = 'arakiya01/kayley';

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function pickAsset(assets) {
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') {
      return assets.find((a) => a.name.endsWith('arm64-mac.zip')) || null;
    }
    return assets.find((a) => a.name.endsWith('-mac.zip') && !a.name.endsWith('arm64-mac.zip')) || null;
  }
  if (process.platform === 'win32') {
    return assets.find((a) => a.name.endsWith('win-x64-portable.zip')) || null;
  }
  return null;
}

async function checkForUpdate(currentVersion) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'Kayley-App' },
    });
    if (!res.ok) throw new Error(`GitHub APIエラー: ${res.status}`);
    const data = await res.json();
    const latestVersion = String(data.tag_name || '').replace(/^v/, '');
    const asset = pickAsset(data.assets || []);
    const available = !!asset && compareVersions(latestVersion, currentVersion) > 0;
    return {
      available,
      currentVersion,
      latestVersion,
      assetUrl: asset ? asset.browser_download_url : null,
      assetName: asset ? asset.name : null,
      releaseUrl: data.html_url || null,
      error: null,
    };
  } catch (err) {
    return {
      available: false,
      currentVersion,
      latestVersion: null,
      assetUrl: null,
      assetName: null,
      releaseUrl: null,
      error: err.message,
    };
  }
}

module.exports = { compareVersions, checkForUpdate };
```

- [ ] **Step 2: `electron/main.js`にIPCハンドラを追加する**

`electron/main.js`の既存の`ipcMain.handle('attachment:delete', ...)`の直後に追加する:

```js
const { checkForUpdate } = require('./updater');

ipcMain.handle('update:check', async () => {
  return checkForUpdate(app.getVersion());
});
```

- [ ] **Step 3: `electron/preload.js`にAPIを追加する**

現状:
```js
const { contextBridge, ipcRenderer } = require('electron');
const { version } = require('../package.json');

contextBridge.exposeInMainWorld('kayleyBridge', {
  appVersion: version,
  saveDb: (bytes) => ipcRenderer.invoke('db:save', bytes),
  loadDb: () => ipcRenderer.invoke('db:load'),
  saveAttachment: (fileName, bytes) => ipcRenderer.invoke('attachment:save', fileName, bytes),
  deleteAttachment: (fileId) => ipcRenderer.invoke('attachment:delete', fileId),
});
```
以下に変更する（`checkForUpdate`の1行を追加するだけ）:
```js
const { contextBridge, ipcRenderer } = require('electron');
const { version } = require('../package.json');

contextBridge.exposeInMainWorld('kayleyBridge', {
  appVersion: version,
  saveDb: (bytes) => ipcRenderer.invoke('db:save', bytes),
  loadDb: () => ipcRenderer.invoke('db:load'),
  saveAttachment: (fileName, bytes) => ipcRenderer.invoke('attachment:save', fileName, bytes),
  deleteAttachment: (fileId) => ipcRenderer.invoke('attachment:delete', fileId),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
});
```

- [ ] **Step 4: 構文チェック**

```bash
node --check electron/updater.js
node --check electron/main.js
node --check electron/preload.js
```
Expected: 出力無し。

- [ ] **Step 5: `compareVersions`の単体動作確認**

```bash
node -e "
const { compareVersions } = require('./electron/updater.js');
console.log('0.1.0 vs 0.0.0:', compareVersions('0.1.0', '0.0.0')); // > 0 を期待
console.log('0.0.0 vs 0.0.0:', compareVersions('0.0.0', '0.0.0')); // 0 を期待
console.log('0.0.0 vs 0.1.0:', compareVersions('0.0.0', '0.1.0')); // < 0 を期待
console.log('1.2.0 vs 1.10.0:', compareVersions('1.2.0', '1.10.0')); // < 0 を期待（文字列比較ではなく数値比較になっていること）
"
```
Expected: 1行目は正の数、2行目は`0`、3行目は負の数、4行目は負の数（`10 > 2`が数値として正しく判定される）。

- [ ] **Step 6: `checkForUpdate`の実際のGitHub API呼び出しを確認する**

```bash
node -e "
require('./electron/updater.js').checkForUpdate('0.0.0').then((r) => console.log(JSON.stringify(r, null, 1)));
"
```
Expected: `latestVersion`が`"0.0.0"`（現在の最新リリースタグ）、`available`が`false`（現在のバージョンと同じなので更新なし）、`assetUrl`にmac/win向けのURLが入っている（実行環境の`process.platform`に応じたもの。このLinux環境では`process.platform`が`linux`なので`pickAsset`が`null`を返し、`assetUrl`は`null`になるのが正しい。Mac/Windows実機で動かした場合にのみ実際のURLが入る想定であることをコメントで報告する）。

- [ ] **Step 7: コミット**

```bash
git add electron/updater.js electron/main.js electron/preload.js
git commit -m "GitHub Releasesを使った更新チェック機能を追加"
```

---

### Task 3: 更新の適用（ダウンロード・展開・入れ替え・再起動）

**Files:**
- Modify: `electron/updater.js`
- Modify: `electron/main.js`
- Modify: `electron/preload.js`

**Interfaces:**
- Consumes: Task 2の`electron/updater.js`（同じファイルに追記する）。
- Produces: `electron/updater.js`から`async applyUpdate(assetUrl): Promise<void>`、`function cleanupBackupIfPresent(): void`をexportに追加する。`window.kayleyBridge.applyUpdate(assetUrl): Promise<void>`をレンダラーから呼べるようにする。Task 4が`applyUpdate`を消費する。

- [ ] **Step 1: `electron/updater.js`の先頭に必要なrequireを追加し、`module.exports`の直前に`applyUpdate`・`cleanupBackupIfPresent`を追記する**

ファイル先頭（`const REPO = ...`の前）に追加:
```js
const { app } = require('electron');
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
```

`module.exports = { compareVersions, checkForUpdate };`の行を削除し、その位置に以下を追記した上で、ファイル末尾に新しい`module.exports`を置く:

```js
function currentAppDir() {
  if (process.platform === 'darwin') {
    // .../Kayley.app/Contents/MacOS/Kayley -> Kayley.app
    return path.dirname(path.dirname(path.dirname(process.execPath)));
  }
  // Windows: .../Kayley/Kayley.exe -> Kayley
  return path.dirname(process.execPath);
}

async function applyUpdate(assetUrl) {
  const workDir = path.join(app.getPath('temp'), `kayley-update-${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });
  const zipPath = path.join(workDir, 'update.zip');

  const res = await fetch(assetUrl);
  if (!res.ok) throw new Error(`ダウンロードに失敗しました: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(zipPath, buf);

  const extractDir = path.join(workDir, 'extracted');
  await fs.mkdir(extractDir, { recursive: true });
  if (process.platform === 'darwin') {
    execFileSync('unzip', ['-o', zipPath, '-d', extractDir]);
  } else {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`]);
  }

  const appName = process.platform === 'darwin' ? 'Kayley.app' : 'Kayley';
  const newAppPath = path.join(extractDir, appName);
  const newExePath = process.platform === 'darwin'
    ? path.join(newAppPath, 'Contents', 'MacOS', 'Kayley')
    : path.join(newAppPath, 'Kayley.exe');
  if (!fssync.existsSync(newExePath)) {
    throw new Error('ダウンロードした更新の中身が想定と異なります（実行ファイルが見つかりません）');
  }

  const oldAppPath = currentAppDir();
  const backupPath = `${oldAppPath}.backup`;

  if (process.platform === 'darwin') {
    const scriptPath = path.join(workDir, 'apply.sh');
    const script = `#!/bin/bash
sleep 2
rm -rf "${backupPath}"
mv "${oldAppPath}" "${backupPath}"
mv "${newAppPath}" "${oldAppPath}"
open "${oldAppPath}"
rm -rf "${workDir}"
`;
    await fs.writeFile(scriptPath, script, { mode: 0o755 });
    spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const scriptPath = path.join(workDir, 'apply.bat');
    const script = `@echo off
timeout /t 2 /nobreak > NUL
rmdir /s /q "${backupPath}" 2>NUL
move "${oldAppPath}" "${backupPath}"
move "${newAppPath}" "${oldAppPath}"
start "" "${path.join(oldAppPath, 'Kayley.exe')}"
rmdir /s /q "${workDir}"
`;
    await fs.writeFile(scriptPath, script);
    spawn('cmd.exe', ['/c', scriptPath], { detached: true, stdio: 'ignore' }).unref();
  }

  app.quit();
}

function cleanupBackupIfPresent() {
  const backupPath = `${currentAppDir()}.backup`;
  if (fssync.existsSync(backupPath)) {
    fssync.rmSync(backupPath, { recursive: true, force: true });
  }
}

module.exports = { compareVersions, checkForUpdate, applyUpdate, cleanupBackupIfPresent };
```

- [ ] **Step 2: `electron/main.js`にIPCハンドラと起動時クリーンアップを追加する**

`ipcMain.handle('update:check', ...)`の直後に追加:
```js
ipcMain.handle('update:apply', async (event, assetUrl) => {
  const { applyUpdate } = require('./updater');
  return applyUpdate(assetUrl);
});
```

`app.whenReady().then(() => { buildMenu(); createWindow(); ... });`を以下のように変更する（`cleanupBackupIfPresent()`を`createWindow()`の前に呼ぶ）:
```js
app.whenReady().then(() => {
  const { cleanupBackupIfPresent } = require('./updater');
  cleanupBackupIfPresent();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
```

- [ ] **Step 3: `electron/preload.js`にAPIを追加する**

`checkForUpdate: () => ipcRenderer.invoke('update:check'),`の直後に追加:
```js
  applyUpdate: (assetUrl) => ipcRenderer.invoke('update:apply', assetUrl),
```

- [ ] **Step 4: 構文チェック**

```bash
node --check electron/updater.js
node --check electron/main.js
node --check electron/preload.js
```
Expected: 出力無し。

- [ ] **Step 5: ダミーzipを使った、ダウンロード〜検証部分までの動作確認**

以下の内容でコミットしない一時スクリプトを作り、実行して結果を確認する（実際にアプリを入れ替える最後のステップの直前、「実行ファイルが見つかることの検証」までを確認する）:

```js
// verify_apply_update.mjs （コミットしない）
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

// 1. 偽のKayley.appっぽい構造を作ってzip化する
const stageDir = path.join(os.tmpdir(), 'fake-kayley-' + Date.now());
const appDir = path.join(stageDir, 'Kayley.app', 'Contents', 'MacOS');
mkdirSync(appDir, { recursive: true });
writeFileSync(path.join(appDir, 'Kayley'), '#!/bin/bash\necho fake\n');
const zipPath = path.join(stageDir, 'fake.zip');
execSync(`cd "${stageDir}" && zip -r -q "${zipPath}" Kayley.app || python3 -c "import shutil; shutil.make_archive('${zipPath.replace('.zip', '')}', 'zip', '${stageDir}', 'Kayley.app')"`);

// 2. ローカルHTTPサーバーでそのzipを配信する
const server = http.createServer((req, res) => {
  const data = require('fs').readFileSync(zipPath);
  res.writeHead(200, { 'Content-Type': 'application/zip' });
  res.end(data);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// 3. applyUpdateのダウンロード〜展開〜検証部分だけを直接呼んで確認する
// （app.quit()やspawnまで到達すると実際に何か起動してしまうため、
//   ここではダウンロード・展開・存在チェックのロジックだけを model として再実装して確認する）
const fetchRes = await fetch(`http://127.0.0.1:${port}/`);
const buf = Buffer.from(await fetchRes.arrayBuffer());
const workDir = path.join(os.tmpdir(), 'kayley-update-test-' + Date.now());
mkdirSync(workDir, { recursive: true });
writeFileSync(path.join(workDir, 'update.zip'), buf);
const extractDir = path.join(workDir, 'extracted');
mkdirSync(extractDir, { recursive: true });
execSync(`unzip -o "${path.join(workDir, 'update.zip')}" -d "${extractDir}"`);
const newExePath = path.join(extractDir, 'Kayley.app', 'Contents', 'MacOS', 'Kayley');
console.log('extracted exe exists:', require('fs').existsSync(newExePath));

server.close();
rmSync(stageDir, { recursive: true, force: true });
rmSync(workDir, { recursive: true, force: true });
```

Run: `node verify_apply_update.mjs`
Expected: `extracted exe exists: true`。（このLinux環境に`unzip`コマンドがあることが前提。無ければ`apt list --installed | grep unzip`等で確認し、無い場合はその旨を報告する。`zip`コマンドが無い場合はスクリプト内の`python3 -c "import shutil..."`のフォールバックが使われる。）

- [ ] **Step 6: 入れ替え・再起動スクリプトの生成内容を目視確認する**

`applyUpdate`関数内で`script`変数に組み立てている文字列（macOSは`.sh`、Windowsは`.bat`）が、実際にどんな内容になるか、ダミーのパスを渡して`console.log`で出力させ、シェルスクリプト・バッチファイルとして文法的に妥当か目視確認する。これは`electron/updater.js`を直接実行するのではなく、該当のテンプレート文字列部分だけを抜き出してNode単体で試す:

```bash
node -e "
const oldAppPath = '/Applications/Kayley.app';
const backupPath = oldAppPath + '.backup';
const newAppPath = '/tmp/extracted/Kayley.app';
const workDir = '/tmp/kayley-update-123';
console.log(\`#!/bin/bash
sleep 2
rm -rf \"\${backupPath}\"
mv \"\${oldAppPath}\" \"\${backupPath}\"
mv \"\${newAppPath}\" \"\${oldAppPath}\"
open \"\${oldAppPath}\"
rm -rf \"\${workDir}\"
\`);
"
```
Expected: 出力されたシェルスクリプトの中身に、パスがダブルクォートで正しく囲まれ、変数が正しく埋め込まれていること（構文エラーになりそうな崩れが無いこと）を目視確認する。

- [ ] **Step 7: 実機での最終確認について**

このステップはCodexでは実行しない（実際にアプリを終了・入れ替え・再起動する破壊的な操作のため）。「Step 5・6までの検証が完了した」ことだけを報告し、実機での最終確認（実際にMacで動かして`applyUpdate`を最後まで通す）は私（Claude Code）が別途行う、という一文を報告に含めること。

- [ ] **Step 8: コミット**

```bash
git add electron/updater.js electron/main.js electron/preload.js
git commit -m "更新の適用（ダウンロード・展開・アプリ本体の入れ替え・再起動）を実装"
```

---

### Task 4: 画面側（更新通知・実行ボタン）

**Files:**
- Modify: `js/app.js`

**Interfaces:**
- Consumes: Task 2・3の`window.kayleyBridge.checkForUpdate()`・`window.kayleyBridge.applyUpdate(assetUrl)`。

現状の`js/app.js`（該当部分。42行目付近のモジュールレベル変数、107〜140行目の`renderNotices()`、182〜197行目の`main()`）:
```js
let state = loadUiState();
```
```js
function renderNotices() {
  const notices = [];
  const today = todayYearMonth();
  let unclosedMonth = null;
  for (let offset = -1; offset >= -24; offset--) {
    const candidate = addMonths(today.year, today.month, offset);
    if (!isMonthAllowed(candidate.year, candidate.month)) continue;
    const completion = getSectionCompletion(candidate.year, candidate.month);
    if (![completion.ar, completion.rent, completion.officer, completion.expenses, completion.report, completion.bank].every(Boolean)) {
      unclosedMonth = candidate;
      break;
    }
  }
  if (unclosedMonth && (unclosedMonth.year !== state.year || unclosedMonth.month !== state.month)) {
    notices.push(`
      <div class="notice-row warning">
        <span class="notice-dot"></span>
        <span class="notice-text">${monthLabel(unclosedMonth.year, unclosedMonth.month)}がまだ締まっていません</span>
        <button class="notice-action" id="notice-open-month">その月を開く</button>
      </div>
    `);
  }
  const slot = document.getElementById('notice-slot');
  slot.innerHTML = notices.join('');
  const openMonthButton = slot.querySelector('#notice-open-month');
  if (openMonthButton) {
    openMonthButton.addEventListener('click', () => {
      state.year = unclosedMonth.year;
      state.month = unclosedMonth.month;
      saveUiState(state);
      renderView();
    });
  }
}
```
```js
async function main() {
  await openDatabase();
  applyTheme();
  if (!location.hash) location.hash = `#/${state.tab}`;
  renderShell();
  renderView();

  // どの画面で入力しても、完了印・締めの残り件数・通知がその場で追いつくようにする。
  // ヘッダだけを描き直すので、入力中のフォームからフォーカスが外れることはない。
  onDataChange(() => {
    if (document.getElementById('spine-top-slot')) renderProgressSpine();
  });

}

main();
```

- [ ] **Step 1: モジュールレベルに更新状態の変数を追加する**

`let state = loadUiState();`の直後に追加:
```js
let updateInfo = null;
let updateStatus = null; // null | 'downloading' | エラーメッセージ文字列
```

- [ ] **Step 2: `renderNotices()`に更新通知を追加する**

`if (unclosedMonth && ...) { notices.push(...); }`ブロックの直後、`const slot = document.getElementById('notice-slot');`の直前に追加:
```js
  if (updateInfo && updateInfo.available) {
    const label = updateStatus === 'downloading'
      ? 'ダウンロード中…（完了するとKayleyが自動的に再起動します）'
      : updateStatus
        ? updateStatus
        : `新しいバージョン（v${updateInfo.latestVersion}）があります`;
    notices.push(`
      <div class="notice-row info">
        <span class="notice-dot"></span>
        <span class="notice-text">${escapeHtml(label)}</span>
        ${updateStatus === 'downloading' ? '' : '<button class="notice-action" id="notice-apply-update">更新する</button>'}
      </div>
    `);
  }
```

`const openMonthButton = slot.querySelector('#notice-open-month');`のブロックの直後（`}`の後）に追加:
```js
  const applyUpdateButton = slot.querySelector('#notice-apply-update');
  if (applyUpdateButton) {
    applyUpdateButton.addEventListener('click', async () => {
      if (!confirm('新しいバージョンをダウンロードして更新します。Kayleyが一度終了し、自動的に再起動します。よろしいですか？')) return;
      updateStatus = 'downloading';
      renderNotices();
      try {
        await window.kayleyBridge.applyUpdate(updateInfo.assetUrl);
      } catch (err) {
        updateStatus = `更新に失敗しました: ${err.message}`;
        renderNotices();
      }
    });
  }
```

- [ ] **Step 3: `main()`で起動時に更新チェックを行う**

`main()`関数の`onDataChange(...)`ブロックの直後（`}`の1つ内側、末尾の空行の位置）に追加:
```js
  if (window.kayleyBridge?.checkForUpdate) {
    window.kayleyBridge.checkForUpdate().then((result) => {
      if (result && result.available) {
        updateInfo = result;
        if (document.getElementById('spine-top-slot')) renderProgressSpine();
      }
    }).catch(() => { /* オフライン等は無視。次回起動時に再チェックされる */ });
  }
```

- [ ] **Step 4: 構文チェック**

```bash
node --check js/app.js
```
Expected: 出力無し。

- [ ] **Step 5: Playwrightで検証する（コミットしないスクリプト）**

`window.kayleyBridge`を、`checkForUpdate`が更新ありを返すようにスタブして、通知が出ること・ボタンを押すと`applyUpdate`が正しい引数で呼ばれること・更新なしの場合は通知が出ないことを確認する。

```js
import { chromium } from '/path/to/playwright-core/index.mjs';
const BASE = process.env.APP_URL;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.addInitScript(() => {
  let saved = null;
  window.__applyUpdateCalledWith = null;
  window.kayleyBridge = {
    appVersion: '0.0.0',
    saveDb: async (bytes) => { saved = bytes; },
    loadDb: async () => saved,
    saveAttachment: async () => 'fake-id',
    deleteAttachment: async () => {},
    checkForUpdate: async () => ({ available: true, currentVersion: '0.0.0', latestVersion: '0.1.0', assetUrl: 'https://example.com/fake.zip', assetName: 'fake.zip', releaseUrl: 'https://example.com', error: null }),
    applyUpdate: async (assetUrl) => { window.__applyUpdateCalledWith = assetUrl; },
  };
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const results = {};
results.noticeVisible = await page.$eval('.notice-text', (el) => el.textContent).catch(() => null);
results.buttonExists = await page.$('#notice-apply-update') !== null;

page.on('dialog', (d) => d.accept());
await page.click('#notice-apply-update');
await page.waitForTimeout(300);
results.applyUpdateCalledWith = await page.evaluate(() => window.__applyUpdateCalledWith);

console.log(JSON.stringify(results, null, 1));
console.log('errors:', JSON.stringify(errors));
await browser.close();
```
Run: 上記スクリプトを実行する。
Expected: `noticeVisible`に「新しいバージョン（v0.1.0）があります」相当の文字列、`buttonExists: true`、`applyUpdateCalledWith: "https://example.com/fake.zip"`。`errors`は空配列。

- [ ] **Step 6: 更新なしの場合に通知が出ないことも確認する**

```js
import { chromium } from '/path/to/playwright-core/index.mjs';
const BASE = process.env.APP_URL;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.addInitScript(() => {
  let saved = null;
  window.kayleyBridge = {
    appVersion: '0.0.0',
    saveDb: async (bytes) => { saved = bytes; },
    loadDb: async () => saved,
    saveAttachment: async () => 'fake-id',
    deleteAttachment: async () => {},
    checkForUpdate: async () => ({ available: false, currentVersion: '0.0.0', latestVersion: '0.0.0', assetUrl: null, assetName: null, releaseUrl: null, error: null }),
    applyUpdate: async () => {},
  };
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const results = {};
results.buttonExists = await page.$('#notice-apply-update') !== null;
results.noticeText = await page.$eval('#notice-slot', (el) => el.textContent).catch(() => '');
results.mentionsUpdate = results.noticeText.includes('新しいバージョン');

console.log(JSON.stringify(results, null, 1));
console.log('errors:', JSON.stringify(errors));
await browser.close();
```
Run: 上記スクリプトを実行する。
Expected: `buttonExists: false`、`mentionsUpdate: false`（更新通知が一切出ていないこと）。`errors`は空配列。

- [ ] **Step 7: コミット**

```bash
git add js/app.js
git commit -m "更新通知UIを追加（GitHub Releasesの新バージョンをヘッダー通知から適用できるようにする）"
```
