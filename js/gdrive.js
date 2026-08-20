// Google Drive 連携（証憑ファイルの保存）。
// このアプリにサーバーは無いため、ブラウザから直接 Google に接続する。
// スコープは drive.file のみ ＝ このアプリが作成したファイルにしかアクセスできない、
// もっとも限定的な権限。Driveの他のファイルは一切見えない・触れない。
import { getMeta, setMeta } from './db.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const FOLDER_NAME = '月次伝票 - 証憑';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

let gisLoaded = null;
let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;

function loadGis() {
  if (gisLoaded) return gisLoaded;
  gisLoaded = new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Googleの認証スクリプトを読み込めませんでした（インターネット接続を確認してください）'));
    document.head.appendChild(script);
  });
  return gisLoaded;
}

export function isConnected() {
  return !!accessToken && Date.now() < tokenExpiresAt;
}

function requestToken(clientId, prompt) {
  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) { reject(new Error(resp.error)); return; }
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
        resolve();
      },
      error_callback: (err) => reject(new Error(err.message || '認証がキャンセルされました')),
    });
    tokenClient.requestAccessToken({ prompt });
  });
}

// 押した瞬間、まずGoogle側のセッションが生きていれば無言で完了を試み（本人がクリックした
// タイミングでのみ実行するため、一瞬ウィンドウが見えても驚かれない）、ダメなら通常の同意画面に切り替える。
export async function connect(clientId) {
  await loadGis();
  if (isConnected()) return;
  try {
    await requestToken(clientId, '');
  } catch {
    await requestToken(clientId, 'consent');
  }
}

export function disconnect() {
  if (accessToken && window.google && window.google.accounts) {
    window.google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiresAt = 0;
}

function authHeader() {
  if (!isConnected()) throw new Error('Google Driveに接続されていません');
  return { Authorization: `Bearer ${accessToken}` };
}

async function findFolder() {
  const cachedId = getMeta('gdrive_folder_id');
  if (cachedId) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${cachedId}?fields=id,trashed`, {
      headers: authHeader(),
    });
    if (res.ok) {
      const data = await res.json();
      if (!data.trashed) return data.id;
    }
  }
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: authHeader(),
  });
  if (!res.ok) throw new Error('Google Driveのフォルダ検索に失敗しました');
  const data = await res.json();
  if (data.files && data.files.length > 0) {
    setMeta('gdrive_folder_id', data.files[0].id);
    return data.files[0].id;
  }
  return null;
}

async function createFolder() {
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!res.ok) throw new Error('Google Driveのフォルダ作成に失敗しました');
  const data = await res.json();
  setMeta('gdrive_folder_id', data.id);
  return data.id;
}

async function ensureFolder() {
  const found = await findFolder();
  if (found) return found;
  return createFolder();
}

export async function uploadFile(file, { year, month }) {
  const folderId = await ensureFolder();
  const name = `${year}-${String(month).padStart(2, '0')}_${file.name}`;
  const metadata = { name, parents: [folderId] };

  const boundary = `geppyo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bodyParts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
    file,
    `\r\n--${boundary}--`,
  ];
  const body = new Blob(bodyParts);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink', {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error('Google Driveへのアップロードに失敗しました');
  return res.json();
}

export async function deleteFile(fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: authHeader(),
  });
  if (!res.ok && res.status !== 404) throw new Error('Google Drive上のファイル削除に失敗しました');
}
