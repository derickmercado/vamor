'use strict';

/**
 * Vamor — a tiny private messenger for two people.
 * Zero dependencies: plain Node http + long polling. No login, no accounts.
 *
 *   node server.js                          -> http://localhost:3000
 *   PORT=8080 NAMES="Derick,Bebe" node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const NAMES = (process.env.NAMES || 'Derick,My Love')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .slice(0, 2);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const MAX_BODY = 20 * 1024 * 1024; // 20MB — a long voice note in opus is way under this

fs.mkdirSync(AUDIO_DIR, { recursive: true });

// ---------------------------------------------------------------- state

/** @type {{id:number,from:string,type:'text'|'voice',text?:string,audio?:string,mime?:string,duration?:number,peaks?:number[],at:number,reaction?:string,deleted?:boolean}[]} */
let messages = [];
let nextId = 1;

try {
  const saved = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  if (Array.isArray(saved.messages)) messages = saved.messages;
  nextId = saved.nextId || messages.reduce((m, x) => Math.max(m, x.id), 0) + 1;
} catch {
  /* first run */
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(MESSAGES_FILE, JSON.stringify({ nextId, messages }, null, 2), (err) =>
      err && console.error('save failed:', err.message)
    );
  }, 120);
}

/** user -> { lastSeen, typingUntil, lastRead } */
const presence = Object.create(null);
function user(name) {
  return (presence[name] ||= { lastSeen: 0, typingUntil: 0, lastRead: 0 });
}

/** Long-poll waiters, released whenever anything changes. */
let waiters = [];
function wake() {
  const pending = waiters;
  waiters = [];
  for (const w of pending) {
    clearTimeout(w.timer);
    try {
      w.send();
    } catch {
      /* client vanished */
    }
  }
}

// ---------------------------------------------------------------- helpers

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** Whoever you say you are — it's a two-person app. */
function who(req, url) {
  const name = String(req.headers['x-user'] || url.searchParams.get('user') || '').trim();
  return name ? name.slice(0, 24) : null;
}

function stateFor(me, since) {
  const now = Date.now();
  return {
    messages: messages.filter((m) => m.id > since),
    // Reactions/unsends can land on old messages, so ship a light index of them too.
    changed: messages
      .filter((m) => m.id <= since && (m.reaction || m.deleted))
      .map((m) => ({ id: m.id, reaction: m.reaction || '', deleted: !!m.deleted })),
    lastId: nextId - 1,
    peers: Object.entries(presence)
      .filter(([n]) => n !== me)
      .map(([n, p]) => ({
        name: n,
        online: now - p.lastSeen < 12000,
        typing: p.typingUntil > now,
        lastSeen: p.lastSeen,
        lastRead: p.lastRead,
      })),
    now,
  };
}

// ---------------------------------------------------------------- static

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'nope' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      return serveStatic(req, res, p);
    }

    // --- who lives here -------------------------------------------
    if (p === '/api/who') return json(res, 200, { names: NAMES });

    // --- voice note audio -----------------------------------------
    if (p.startsWith('/api/audio/')) {
      const id = Number(p.slice('/api/audio/'.length));
      const msg = messages.find((m) => m.id === id && m.type === 'voice' && m.audio);
      if (!msg) return json(res, 404, { error: 'not found' });
      return fs.readFile(path.join(AUDIO_DIR, msg.audio), (err, buf) => {
        if (err) return json(res, 404, { error: 'gone' });
        res.writeHead(200, {
          'Content-Type': msg.mime || 'audio/webm',
          'Content-Length': buf.length,
          'Cache-Control': 'private, max-age=31536000',
        });
        res.end(buf);
      });
    }

    const me = who(req, url);
    if (!me) return json(res, 400, { error: 'missing user' });
    const u = user(me);
    u.lastSeen = Date.now();

    // --- long-poll sync -------------------------------------------
    if (p === '/api/sync' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const wait = url.searchParams.get('wait') !== '0';
      if (!wait || messages.some((m) => m.id > since)) {
        return json(res, 200, stateFor(me, since));
      }
      const waiter = {
        send() {
          if (!res.writableEnded) json(res, 200, stateFor(me, since));
        },
      };
      waiter.timer = setTimeout(() => {
        waiters = waiters.filter((w) => w !== waiter);
        waiter.send();
      }, 25000);
      waiters.push(waiter);
      res.on('close', () => {
        clearTimeout(waiter.timer);
        waiters = waiters.filter((w) => w !== waiter);
      });
      return;
    }

    // --- send ------------------------------------------------------
    if (p === '/api/send' && req.method === 'POST') {
      const body = await readBody(req);
      const type = body.type === 'voice' ? 'voice' : 'text';
      const msg = { id: nextId++, from: me, type, at: Date.now() };

      if (type === 'text') {
        const text = String(body.text || '').trim().slice(0, 4000);
        if (!text) return json(res, 400, { error: 'empty' });
        msg.text = text;
      } else {
        const raw = String(body.audio || '');
        const buf = Buffer.from(raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw, 'base64');
        if (!buf.length) return json(res, 400, { error: 'empty audio' });
        const mime = /^audio\/[\w.+-]+$/.test(body.mime || '') ? body.mime : 'audio/webm';
        const ext = mime.includes('mp4') ? '.m4a' : mime.includes('ogg') ? '.ogg' : '.webm';
        msg.audio = `${msg.id}${ext}`;
        msg.mime = mime;
        msg.duration = Math.max(0, Number(body.duration) || 0);
        msg.peaks = Array.isArray(body.peaks)
          ? body.peaks.slice(0, 64).map((n) => Math.min(1, Math.max(0, Number(n) || 0)))
          : [];
        fs.writeFileSync(path.join(AUDIO_DIR, msg.audio), buf);
      }

      messages.push(msg);
      u.typingUntil = 0;
      save();
      wake();
      return json(res, 200, { ok: true, message: msg });
    }

    // --- typing indicator ------------------------------------------
    if (p === '/api/typing' && req.method === 'POST') {
      const body = await readBody(req);
      u.typingUntil = body.on === false ? 0 : Date.now() + 4000;
      wake();
      return json(res, 200, { ok: true });
    }

    // --- read receipt ----------------------------------------------
    if (p === '/api/read' && req.method === 'POST') {
      const body = await readBody(req);
      const last = Number(body.lastId) || 0;
      if (last > u.lastRead) {
        u.lastRead = last;
        wake();
      }
      return json(res, 200, { ok: true });
    }

    // --- react -------------------------------------------------------
    if (p === '/api/react' && req.method === 'POST') {
      const body = await readBody(req);
      const msg = messages.find((m) => m.id === Number(body.id));
      if (!msg) return json(res, 404, { error: 'not found' });
      const emoji = String(body.reaction || '').slice(0, 8);
      if (emoji) msg.reaction = emoji;
      else delete msg.reaction;
      save();
      wake();
      return json(res, 200, { ok: true });
    }

    // --- unsend -------------------------------------------------------
    if (p === '/api/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const msg = messages.find((m) => m.id === Number(body.id));
      if (!msg) return json(res, 404, { error: 'not found' });
      if (msg.from !== me) return json(res, 403, { error: 'not yours' });
      if (msg.audio) fs.rm(path.join(AUDIO_DIR, msg.audio), { force: true }, () => {});
      msg.type = 'text';
      msg.text = 'unsent a message';
      msg.deleted = true;
      delete msg.audio;
      delete msg.peaks;
      delete msg.duration;
      save();
      wake();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'no such endpoint' });
  } catch (err) {
    console.error(err);
    if (!res.writableEnded) json(res, 500, { error: 'server error' });
  }
});

// Nudge long-polls periodically so presence/typing stay fresh.
setInterval(wake, 8000).unref();

server.listen(PORT, () => {
  const lan = Object.values(require('os').networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  console.log('\n  💌  Vamor is running');
  console.log(`      local:   http://localhost:${PORT}`);
  lan.forEach((ip) => console.log(`      network: http://${ip}:${PORT}`));
  console.log(`      people:  ${NAMES.join('  &  ')}\n`);
});
