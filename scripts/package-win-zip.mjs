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
