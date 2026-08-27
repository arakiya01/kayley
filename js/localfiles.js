// 添付ファイル（領収書・請求書）のローカル保存。
// Electronのpreload（electron/preload.js）が公開する window.kayleyBridge 経由で、
// メインプロセスのファイルシステムに保存する。ブラウザ単体（Electron外）では使えない。
export function isAvailable() {
  return typeof window !== 'undefined' && !!window.kayleyBridge;
}

export async function uploadFile(file, { namePrefix = '' } = {}) {
  if (!isAvailable()) throw new Error('この機能はデスクトップアプリでのみ使えます。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const safeName = `${namePrefix ? `${namePrefix}_` : ''}${file.name}`;
  const id = await window.kayleyBridge.saveAttachment(safeName, bytes);
  return { id, mimeType: file.type || 'application/octet-stream' };
}

export async function deleteFile(fileId) {
  if (!isAvailable()) return;
  await window.kayleyBridge.deleteAttachment(fileId);
}

export function previewUrl(fileId) {
  return `/attachments/${encodeURIComponent(fileId)}`;
}

export async function downloadFile(fileId) {
  const res = await fetch(previewUrl(fileId));
  if (!res.ok) throw new Error('ファイルの読み込みに失敗しました');
  return await res.blob();
}
