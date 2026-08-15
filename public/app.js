'use strict';

/* -------------------------------------------------------------- setup */

const $ = (id) => document.getElementById(id);
const api = (p, opts = {}) =>
  fetch(p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-User': me || '', ...(opts.headers || {}) },
  });

let me = localStorage.getItem('vamor.me') || '';
let names = [];
let lastId = 0;
let peer = null;
const byId = new Map(); // message id -> { msg, el, bubble }
let lastRow = null;
let scrollPinned = true;

/* --------------------------------------------------------------- theme */

const savedTheme =
  localStorage.getItem('vamor.theme') ||
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = savedTheme;

$('btnTheme').onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('vamor.theme', next);
};

/* ------------------------------------------------- mobile viewport */

/* Phone keyboards shrink the visual viewport without changing 100dvh on some
   browsers, which pushes the composer under the keyboard. Track it directly. */
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    document.documentElement.style.setProperty('--vh', `${vv.height}px`);
    if (scrollPinned) scrollDown(true);
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}

// Keep the newest message visible when the keyboard opens.
$('input').addEventListener('focus', () => setTimeout(() => scrollDown(true), 250));

/* ------------------------------------------------------ who are you */

async function boot() {
  names = (await (await fetch('/api/who')).json()).names;

  // /?me=Bebe lets each of you bookmark a link that skips the picker.
  const asked = new URLSearchParams(location.search).get('me');
  if (asked && names.includes(asked)) {
    me = asked;
    localStorage.setItem('vamor.me', me);
    history.replaceState(null, '', location.pathname);
  }

  if (me && names.includes(me)) return enter();

  $('pickList').innerHTML = '';
  names.forEach((n, i) => {
    const b = document.createElement('button');
    b.className = 'pick-btn';
    b.innerHTML = `<span class="avatar">${i === 0 ? '💙' : '💖'}</span><span></span>`;
    b.lastElementChild.textContent = n;
    b.onclick = () => {
      me = n;
      localStorage.setItem('vamor.me', n);
      enter();
    };
    $('pickList').append(b);
  });
}

function enter() {
  $('pick').hidden = true;
  $('chat').hidden = false;
  const other = names.find((n) => n !== me) || 'Her';
  $('peerName').textContent = other;
  $('peerAvatar').textContent = names.indexOf(other) === 0 ? '💙' : '💖';
  $('input').focus();
  sync();
}

$('btnSwitch').onclick = () => {
  localStorage.removeItem('vamor.me');
  location.reload();
};

/* ---------------------------------------------------------- rendering */

const pad = (n) => String(n).padStart(2, '0');
const clock = (t) => {
  const d = new Date(t);
  const h = d.getHours();
  return `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
};
const mmss = (s) => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;

function dayLabel(t) {
  const d = new Date(t);
  const today = new Date();
  const yday = new Date(today.getTime() - 864e5);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function addMessage(msg) {
  if (byId.has(msg.id)) return updateMessage(msg);
  $('empty').hidden = true;

  const prev = [...byId.values()].pop();
  if (!prev || dayLabel(prev.msg.at) !== dayLabel(msg.at)) {
    const sep = document.createElement('div');
    sep.className = 'daysep';
    sep.textContent = dayLabel(msg.at);
    $('thread').append(sep);
    lastRow = null;
  }

  const row = document.createElement('div');
  row.className = `row ${msg.from === me ? 'out' : 'in'} tail`;
  row.dataset.id = msg.id;

  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = clock(msg.at);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (msg.type === 'voice') {
    bubble.append(voiceBody(msg));
  } else if (msg.deleted) {
    bubble.classList.add('deleted');
    bubble.textContent = msg.from === me ? 'You unsent a message' : 'Unsent a message';
  } else {
    bubble.textContent = msg.text;
    // A message that's nothing but emoji deserves to be big.
    if (/^\p{Extended_Pictographic}{1,3}$/u.test(msg.text.trim())) {
      bubble.style.fontSize = '38px';
      bubble.style.background = 'none';
      bubble.style.padding = '2px 8px';
    }
  }

  if (msg.reaction) {
    bubble.append(reactionChip(msg.reaction));
    row.classList.add('reacted');
  }

  // Long-press (or right-click) a bubble to react.
  let hold;
  const open = (e) => openReactions(e, msg);
  bubble.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    open(e);
  });
  bubble.addEventListener('pointerdown', (e) => {
    hold = setTimeout(() => open(e), 450);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) =>
    bubble.addEventListener(ev, () => clearTimeout(hold))
  );

  row.append(msg.from === me ? time : bubble, msg.from === me ? bubble : time);

  // Group consecutive messages from the same person.
  row.dataset.from = msg.from;
  if (lastRow?.dataset.from === msg.from) lastRow.classList.remove('tail');
  lastRow = row;

  $('thread').append(row);
  byId.set(msg.id, { msg, el: row, bubble });
}

function updateMessage(patch) {
  const entry = byId.get(patch.id);
  if (!entry) return;
  const { msg, bubble, el } = entry;

  if (patch.deleted && !msg.deleted) {
    msg.deleted = true;
    bubble.replaceChildren();
    bubble.classList.add('deleted');
    bubble.textContent = msg.from === me ? 'You unsent a message' : 'Unsent a message';
  }

  if ((patch.reaction || '') !== (msg.reaction || '')) {
    msg.reaction = patch.reaction || '';
    bubble.querySelector('.reaction')?.remove();
    if (msg.reaction) bubble.append(reactionChip(msg.reaction));
    el.classList.toggle('reacted', !!msg.reaction);
  }
}

function reactionChip(emoji) {
  const s = document.createElement('span');
  s.className = 'reaction';
  s.textContent = emoji;
  return s;
}

/* ------------------------------------------------------- voice bubble */

function voiceBody(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'voice';

  const play = document.createElement('button');
  play.className = 'play';
  play.textContent = '▶';

  const wave = document.createElement('div');
  wave.className = 'wave';
  const peaks = msg.peaks?.length ? msg.peaks : Array.from({ length: 34 }, () => 0.35);
  const bars = peaks.map((p) => {
    const b = document.createElement('i');
    b.style.height = `${Math.round(14 + p * 86)}%`;
    wave.append(b);
    return b;
  });

  const dur = document.createElement('span');
  dur.className = 'dur';
  dur.textContent = mmss(msg.duration || 0);

  const audio = new Audio(`/api/audio/${msg.id}`);
  audio.preload = 'none';

  const paint = (ratio) => {
    const upto = Math.round(ratio * bars.length);
    bars.forEach((b, i) => b.classList.toggle('on', i < upto));
  };

  play.onclick = (e) => {
    e.stopPropagation();
    document.querySelectorAll('audio').forEach((a) => a !== audio && a.pause());
    if (audio.paused) audio.play().catch(() => toast('Could not play that clip'));
    else audio.pause();
  };

  wave.onclick = (e) => {
    const r = wave.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const total = audio.duration || msg.duration || 0;
    if (total) audio.currentTime = ratio * total;
    paint(ratio);
  };

  audio.onplay = () => (play.textContent = '❚❚');
  audio.onpause = () => (play.textContent = '▶');
  audio.ontimeupdate = () => {
    const total = audio.duration && isFinite(audio.duration) ? audio.duration : msg.duration || 1;
    dur.textContent = mmss(Math.max(0, total - audio.currentTime));
    paint(audio.currentTime / total);
  };
  audio.onended = () => {
    play.textContent = '▶';
    dur.textContent = mmss(msg.duration || 0);
    paint(0);
    audio.currentTime = 0;
  };

  wrap.append(play, wave, dur);
  return wrap;
}

/* ---------------------------------------------------------- reactions */

let reactTarget = null;

function openReactions(e, msg) {
  reactTarget = msg;
  const box = $('reactions');
  box.hidden = false;
  const r = box.getBoundingClientRect();
  const x = Math.min(Math.max(8, (e.clientX || 40) - r.width / 2), innerWidth - r.width - 8);
  const y = Math.max(8, (e.clientY || 80) - r.height - 12);
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;

  box.querySelector('.trash')?.remove();
  if (msg.from === me && !msg.deleted) {
    const t = document.createElement('button');
    t.className = 'trash';
    t.textContent = '🗑';
    t.onclick = async () => {
      box.hidden = true;
      await api('/api/delete', { method: 'POST', body: JSON.stringify({ id: msg.id }) });
    };
    box.append(t);
  }
}

$('reactions').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-e]');
  if (!btn || !reactTarget) return;
  $('reactions').hidden = true;
  const emoji = btn.dataset.e === reactTarget.reaction ? '' : btn.dataset.e;
  await api('/api/react', {
    method: 'POST',
    body: JSON.stringify({ id: reactTarget.id, reaction: emoji }),
  });
});

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#reactions') && !e.target.closest('.bubble')) $('reactions').hidden = true;
});

/* ------------------------------------------------------------- toast */

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

/* --------------------------------------------------------- send text */

async function sendText() {
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  try {
    const r = await api('/api/send', { method: 'POST', body: JSON.stringify({ type: 'text', text }) });
    if (!r.ok) throw new Error();
  } catch {
    $('input').value = text;
    toast('Not sent — check the connection');
  }
}

$('btnSend').onclick = sendText;
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendText();
  }
});

let typingSent = 0;
$('input').addEventListener('input', () => {
  const now = Date.now();
  if ($('input').value && now - typingSent > 2500) {
    typingSent = now;
    api('/api/typing', { method: 'POST', body: JSON.stringify({ on: true }) }).catch(() => {});
  }
});

/* ------------------------------------------------------ voice mails */

let rec = null; // { recorder, chunks, stream, startedAt, locked, ctx, raf }

const MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

async function startRecording() {
  if (rec) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    return toast('Microphone blocked — allow it in your browser');
  }

  const mimeType = MIMES.find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start();

  rec = { recorder, chunks, stream, startedAt: Date.now(), locked: false, cancelled: false };

  $('recBar').hidden = false;
  $('btnMic').classList.add('recording');
  tickTimer();
  liveWave(stream);

  recorder.onstop = () => finishRecording();
}

function tickTimer() {
  if (!rec) return;
  $('recTime').textContent = mmss((Date.now() - rec.startedAt) / 1000);
  rec.timer = setTimeout(tickTimer, 200);
}

/** Live input level drawn on the little canvas while recording. */
function liveWave(stream) {
  const canvas = $('recWave');
  const ctx2d = canvas.getContext('2d');
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const analyser = ac.createAnalyser();
  analyser.fftSize = 512;
  ac.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const history = [];
  rec.ac = ac;

  (function draw() {
    if (!rec) return;
    rec.raf = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
    history.push(peak);

    const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
    const h = (canvas.height = canvas.clientHeight * devicePixelRatio);
    const barW = 3 * devicePixelRatio;
    const gap = 2 * devicePixelRatio;
    const count = Math.floor(w / (barW + gap));
    const slice = history.slice(-count);

    ctx2d.clearRect(0, 0, w, h);
    ctx2d.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    slice.forEach((p, i) => {
      const bh = Math.max(2 * devicePixelRatio, p * h);
      ctx2d.beginPath();
      ctx2d.roundRect(i * (barW + gap), (h - bh) / 2, barW, bh, barW / 2);
      ctx2d.fill();
    });
  })();
}

function teardown() {
  if (!rec) return;
  clearTimeout(rec.timer);
  cancelAnimationFrame(rec.raf);
  rec.ac?.close().catch(() => {});
  rec.stream.getTracks().forEach((t) => t.stop());
  $('recBar').hidden = true;
  $('btnMic').classList.remove('recording');
  $('recTime').textContent = '0:00';
}

function stopRecording({ cancel = false } = {}) {
  if (!rec) return;
  rec.cancelled = cancel;
  if (rec.recorder.state !== 'inactive') rec.recorder.stop();
  else finishRecording();
}

async function finishRecording() {
  const r = rec;
  if (!r) return;
  const seconds = (Date.now() - r.startedAt) / 1000;
  teardown();
  rec = null;

  if (r.cancelled) return;
  if (seconds < 0.6) return toast('Hold the mic a little longer');

  const blob = new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' });
  if (!blob.size) return toast('Nothing was recorded');

  const [peaks, audio] = await Promise.all([peaksFrom(blob), blobToBase64(blob)]);

  try {
    const res = await api('/api/send', {
      method: 'POST',
      body: JSON.stringify({
        type: 'voice',
        audio,
        mime: (r.recorder.mimeType || 'audio/webm').split(';')[0],
        duration: seconds,
        peaks,
      }),
    });
    if (!res.ok) throw new Error();
  } catch {
    toast('Voice mail failed to send');
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

/** Downsample the clip to 34 bars so the bubble shows a real waveform. */
async function peaksFrom(blob, bars = 34) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    const buf = await ac.decodeAudioData(await blob.arrayBuffer());
    const data = buf.getChannelData(0);
    const step = Math.floor(data.length / bars) || 1;
    const out = [];
    for (let i = 0; i < bars; i++) {
      let peak = 0;
      for (let j = i * step; j < (i + 1) * step && j < data.length; j++) {
        peak = Math.max(peak, Math.abs(data[j]));
      }
      out.push(peak);
    }
    ac.close();
    const max = Math.max(...out, 0.01);
    return out.map((p) => Number((p / max).toFixed(2)));
  } catch {
    return []; // decoding isn't supported everywhere; the bubble falls back to flat bars
  }
}

// Hold to record; a quick tap locks recording on until you tap again.
const mic = $('btnMic');
mic.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (rec?.locked) return stopRecording();
  startRecording();
});
mic.addEventListener('pointerup', () => {
  if (!rec) return;
  if (Date.now() - rec.startedAt < 450) {
    rec.locked = true;
    $('recBar').querySelector('.rec-hint').textContent = 'tap the mic to send';
  } else {
    stopRecording();
  }
});
mic.addEventListener('pointercancel', () => rec && !rec.locked && stopRecording({ cancel: true }));
$('recCancel').onclick = () => stopRecording({ cancel: true });

/* ------------------------------------------------------------- sync */

function renderPeer(peers) {
  peer = peers.find((p) => p.name !== me) || peers[0] || null;
  const online = !!peer?.online;
  $('peerAvatar').classList.toggle('online', online);
  const status = $('peerStatus');
  status.classList.toggle('on', online);
  if (!peer) status.textContent = 'not here yet';
  else if (peer.typing) status.textContent = 'typing…';
  else if (online) status.textContent = 'Active now';
  else if (peer.lastSeen) status.textContent = `Active ${ago(peer.lastSeen)}`;
  else status.textContent = 'offline';

  $('typing').hidden = !peer?.typing;
  if (peer?.typing && scrollPinned) scrollDown();
  renderReceipt();
}

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function renderReceipt() {
  document.querySelector('.receipt')?.remove();
  if (!peer?.lastRead) return;
  const mine = [...byId.values()].filter((e) => e.msg.from === me);
  const last = mine[mine.length - 1];
  if (!last || peer.lastRead < last.msg.id) return;
  const d = document.createElement('div');
  d.className = 'receipt';
  d.textContent = 'Seen';
  last.el.after(d);
}

function scrollDown(instant = false) {
  const t = $('thread');
  t.scrollTo({ top: t.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
}

$('thread').addEventListener('scroll', () => {
  const t = $('thread');
  scrollPinned = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
});

let failures = 0;

async function sync() {
  try {
    const res = await api(`/api/sync?since=${lastId}&user=${encodeURIComponent(me)}`);
    if (!res.ok) throw new Error(res.status);
    const state = await res.json();
    failures = 0;

    const fresh = state.messages.length;
    const first = lastId === 0;
    for (const m of state.messages) {
      addMessage(m);
      lastId = Math.max(lastId, m.id);
      if (!first && m.from !== me) ping();
    }
    state.changed?.forEach(updateMessage);
    renderPeer(state.peers || []);

    if (fresh && (scrollPinned || first)) scrollDown(first);
    if (fresh && document.visibilityState === 'visible') markRead();
  } catch {
    failures++;
    $('peerStatus').textContent = 'reconnecting…';
    await new Promise((r) => setTimeout(r, Math.min(8000, 500 * failures)));
  }
  sync();
}

function markRead() {
  if (!lastId) return;
  api('/api/read', { method: 'POST', body: JSON.stringify({ lastId }) }).catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') markRead();
});

/** A soft chime for incoming messages — no audio files needed. */
function ping() {
  if (document.visibilityState === 'visible' && document.hasFocus()) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ac.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ac.currentTime + 0.12);
      gain.gain.setValueAtTime(0.0001, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, ac.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.35);
      osc.connect(gain).connect(ac.destination);
      osc.start();
      osc.stop(ac.currentTime + 0.36);
      setTimeout(() => ac.close(), 600);
    } catch {
      /* autoplay policy — never mind */
    }
    return;
  }
  if (Notification?.permission === 'granted') {
    new Notification(`${peer?.name || 'She'} sent you something 💌`);
  }
}

if ('Notification' in window && Notification.permission === 'default') {
  document.addEventListener('click', () => Notification.requestPermission(), { once: true });
}

boot();
