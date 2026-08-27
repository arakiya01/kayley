// GitHub Releasesを使った自前の更新チェック・適用。
// electron-updater（Squirrel.Mac）は署名済みアプリを要求するため使わず、
// 「zipをダウンロード→展開→アプリ本体を入れ替え→再起動」を自前で行う。
const { app } = require('electron');
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

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
    // /releases/latest はプレリリース（prerelease）を除外してしまい、
    // 開発初期のようにプレリリースしか無い場合は404になる。
    // 一覧APIから先頭（＝作成日時が最新のもの）を使うことで、
    // プレリリースかどうかによらず常に最新のリリースを拾えるようにする。
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=1`, {
      headers: { 'User-Agent': 'Kayley-App' },
    });
    if (!res.ok) throw new Error(`GitHub APIエラー: ${res.status}`);
    const releases = await res.json();
    if (!Array.isArray(releases) || releases.length === 0) throw new Error('リリースが見つかりません');
    const data = releases[0];
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
