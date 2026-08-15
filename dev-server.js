'use strict';

/**
 * Local preview only — serves public/ so you can test before deploying.
 * In production Vercel serves these files; there is no backend to run.
 * The app talks to Supabase directly either way.
 *
 *   node dev-server.js     -> http://localhost:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.join(PUBLIC_DIR, rel);

    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      });
      res.end(buf);
    });
  })
  .listen(PORT, () => {
    console.log(`\n  💌  Vamor preview -> http://localhost:${PORT}\n`);
  });
