const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { startServer } = require('./server');

let mainWindow = null;

function buildMenu() {
  // 「リテラシーが高くないユーザー」向けに、開発者向けメニュー（表示>開発者ツール等）を削る。
  // 万一の調査用にCmd/Ctrl+Alt+Iだけは裏technicalショートカットとして生かしておく。
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '元に戻す' },
        { role: 'redo', label: 'やり直す' },
        { type: 'separator' },
        { role: 'cut', label: '切り取り' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: '貼り付け' },
        { role: 'selectAll', label: 'すべて選択' },
      ],
    },
    {
      label: '表示',
      submenu: [
        { role: 'reload', label: '再読み込み' },
        { type: 'separator' },
        { role: 'resetZoom', label: '実際のサイズ' },
        { role: 'zoomIn', label: '拡大' },
        { role: 'zoomOut', label: '縮小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'フルスクリーン' },
      ],
    },
    {
      label: 'ウィンドウ',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '閉じる' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const DATA_DIR = app.getPath('userData');
const DB_PATH = path.join(DATA_DIR, 'kayley.sqlite');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');

ipcMain.handle('db:save', async (event, bytes) => {
  await fs.writeFile(DB_PATH, Buffer.from(bytes));
});

ipcMain.handle('db:load', async () => {
  try {
    const buf = await fs.readFile(DB_PATH);
    return new Uint8Array(buf);
  } catch {
    return null;
  }
});

ipcMain.handle('attachment:save', async (event, fileName, bytes) => {
  await fs.mkdir(ATTACHMENTS_DIR, { recursive: true });
  const safeName = String(fileName).replace(/[/\\]/g, '_');
  const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  await fs.writeFile(path.join(ATTACHMENTS_DIR, fileId), Buffer.from(bytes));
  return fileId;
});

ipcMain.handle('attachment:delete', async (event, fileId) => {
  try {
    await fs.unlink(path.join(ATTACHMENTS_DIR, String(fileId)));
  } catch {
    // 既に無い場合は成功扱い（削除したい状態と一致しているため）
  }
});

const { checkForUpdate } = require('./updater');

ipcMain.handle('update:check', async () => {
  return checkForUpdate(app.getVersion());
});

ipcMain.handle('update:apply', async (event, assetUrl) => {
  const { applyUpdate } = require('./updater');
  return applyUpdate(assetUrl);
});

async function createWindow() {
  const server = await startServer(ATTACHMENTS_DIR);
  const { port } = server.address();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#FBF8F1',
    title: 'Kayley',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // 印刷（PDF出力）ダイアログ用に、外部リンクは既定のブラウザで開く
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);

  // デバウンス中のDB保存（js/db.jsのschedulePersist、最大250ms）が反映されないまま
  // ウィンドウが閉じてデータが失われるのを防ぐため、実際に閉じる前に強制的に保存を
  // 完了させる。閉じるボタン・Cmd+Q・メニューの「終了」のいずれもこのcloseイベントを
  // 経由する。
  let closeConfirmed = false;
  mainWindow.on('close', (event) => {
    if (closeConfirmed) return;
    event.preventDefault();
    const flush = mainWindow.webContents.executeJavaScript(
      'window.__kayleyFlushSave ? window.__kayleyFlushSave() : Promise.resolve()'
    ).catch(() => {});
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    Promise.race([flush, timeout]).then(() => {
      closeConfirmed = true;
      if (mainWindow) mainWindow.close();
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    server.close();
  });
}

app.whenReady().then(() => {
  const { cleanupBackupIfPresent } = require('./updater');
  cleanupBackupIfPresent();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
