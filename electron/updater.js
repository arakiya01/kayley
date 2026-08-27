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

module.exports = { compareVersions, checkForUpdate };
