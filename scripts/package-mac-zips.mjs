// electron-builder に --mac dir でアプリ本体だけを作らせた後、
// 「はじめにこれをダブルクリック.command」（隔離属性を外して起動するヘルパー）を
// Kayley.app と同じ階層に同梱してからzip化する。
// これにより、未署名アプリでmacOSが出す「"Kayley.app" is damaged and can't be opened」
// という誤解を招く表示に、非エンジニアのユーザーがターミナルを使わず対処できる。
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
  if (!existsSync(appPath)) {
    console.log(`skip: ${appPath} が無いのでこのアーキテクチャはビルドされていません`);
    continue;
  }
  const helperDest = path.join(dir, helperScriptName);
  copyFileSync(helperScriptSrc, helperDest);
  chmodSync(helperDest, 0o755);

  const zipPath = path.join(ROOT, 'dist', zipName);
  if (existsSync(zipPath)) unlinkSync(zipPath);

  execFileSync(path7za, ['a', '-tzip', '-mx=9', '-mcu', zipPath, `${productName}.app`, helperScriptName], { cwd: dir, stdio: 'inherit' });
  unlinkSync(helperDest);
  console.log(`作成しました: ${zipPath}`);
}
