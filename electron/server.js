const http = require('http');
const fs = require('fs');
const path = require('path');

// Kayleyはブラウザ完結型アプリ（ESモジュール＋WASM）で、fetch()がfile://を扱えないため
// file://で直接開くとsql.jsのWASM読み込み等が失敗する。そのためElectron内で
// 127.0.0.1宛のごく単純な静的ファイルサーバーを立て、http://経由で読み込む。
// 外部からの接続は受け付けない（127.0.0.1固定・ポートは起動毎にOSへ割り当てさせる）。

const APP_ROOT = path.join(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pf': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqPath = decodeURIComponent(req.url.split('?')[0]);
      if (reqPath === '/') reqPath = '/index.html';
      const filePath = path.normalize(path.join(APP_ROOT, reqPath));
      // ディレクトリ脱出防止
      if (!filePath.startsWith(APP_ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startServer, APP_ROOT };
