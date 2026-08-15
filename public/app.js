import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/* -------------------------------------------------------------- setup */

const $ = (id) => document.getElementById(id);
const cfg = window.VAMOR_CONFIG || {};

if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR-PROJECT')) {
  document.body.innerHTML =
    '<div class="screen" style="place-content:center;text-align:center;padding:24px">' +
    '<p>Fill in your Supabase URL and anon key in <b>public/config.js</b>.</p></div>';
  throw new Error('config.js not filled in');
}

const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

let myId = null; // auth user uuid
let myEmail = '';
let myName = '';
let mine = null; // my row in `members`
let peer = null; // the other row in `members`
let room = null; // realtime presence channel
let peerOnline = false;
let peerTyping = false;

const byId = new Map(); // message id -> { msg, el, bubble }
let lastRow = null;
let lastId = 0;
let scrollPinned = true;

/* --------------------------------------------------------------- theme */

document.documentElement.dataset.theme =
  localStorage.getItem('vamor.theme') ||
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

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

$('input').addEventListener('focus', () => setTimeout(() => scrollDown(true), 250));

/* ---------------------------------------------------------------- auth */

const show = (id) => {
  for (const s of ['splash', 'auth', 'lock', 'chat']) $(s).hidden = s !== id;
};

function authError(msg) {
  const el = $('authError');
  el.textContent = msg;
  el.hidden = !msg;
}

let pendingEmail = '';

$('emailForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim().toLowerCase();
  if (!email) return;
  const btn = $('emailForm').querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  authError('');

  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin },
  });

  btn.disabled = false;
  btn.textContent = 'Send me the link';
  if (error) return authError(error.message);

  pendingEmail = email;
  $('sentTo').textContent = email;
  $('emailForm').hidden = true;
  $('codeForm').hidden = false;
  $('code').focus();
});

$('codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('code').value.trim();
  if (token.length !== 6) return authError('That code should be 6 digits.');
  const btn = $('codeForm').querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  authError('');

  const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token, type: 'email' });

  btn.disabled = false;
  btn.textContent = 'Sign in';
  if (error) return authError(error.message);
  // onAuthStateChange takes it from here.
});

$('backToEmail').onclick = () => {
  $('codeForm').hidden = true;
  $('emailForm').hidden = false;
  authError('');
};

$('btnSignOut').onclick = async () => {
  if (!confirm('Sign out of this device?')) return;
  await sb.auth.signOut();
  location.reload();
};

/* ---------------------------------------------------------------- lock */

/* A screen lock over an already-signed-in session. It stops someone holding
   an unlocked phone; it is not a security boundary, since the check runs in
   the browser. Row Level Security is what actually guards the data. */

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const lockRequired = () => !!cfg.PASSPHRASE_SHA256;
const unlocked = () => sessionStorage.getItem('vamor.unlocked') === cfg.PASSPHRASE_SHA256;

$('lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = $('passphrase').value;
  const err = $('lockError');
  err.hidden = true;

  if ((await sha256(value)) !== cfg.PASSPHRASE_SHA256) {
    err.textContent = 'That is not it.';
    err.hidden = false;
    $('passphrase').select();
    return;
  }

  sessionStorage.setItem('vamor.unlocked', cfg.PASSPHRASE_SHA256);
  $('passphrase').value = '';
  openChat();
});

$('lockSignOut').onclick = async () => {
  await sb.auth.signOut();
  location.reload();
};

/* ---------------------------------------------------------------- boot */

sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session && !myId) start(session);
  if (event === 'SIGNED_OUT') location.reload();
});

(async function boot() {
  const { data } = await sb.auth.getSession();
  if (data.session) return start(data.session);
  show('auth');
})();

async function start(session) {
  myId = session.user.id;
  myEmail = (session.user.email || '').toLowerCase();
  show('splash');

  // The `members` table is the allowlist. If RLS hides it, you're not on it.
  const { data: members, error } = await sb.from('members').select('*');

  if (error || !members?.length) {
    show('auth');
    $('emailForm').hidden = true;
    $('codeForm').hidden = true;
    $('authNote').hidden = false;
    $('authNote').innerHTML =
      `<b>${myEmail}</b> isn't on the list for this conversation.<br />` +
      `Add it to the <code>members</code> table in Supabase, then reload.`;
    return;
  }

  mine = members.find((m) => m.email === myEmail) || null;
  myName = mine?.display_name || 'Me';
  peer = members.find((m) => m.email !== myEmail) || null;

  $('peerName').textContent = peer?.display_name || 'Waiting for her…';
  paintAvatar($('peerAvatar'), peer);
  paintAvatar($('btnMe'), mine);

  if (lockRequired() && !unlocked()) {
    show('lock');
    $('passphrase').focus();
    return;
  }
  await openChat();
}

let chatStarted = false;

async function openChat() {
  show('chat');
  if (chatStarted) return;
  chatStarted = true;

  await subscribe();
  await loadMessages();
  joinRoom();
  heartbeat();
  $('input').focus();
}

/* ------------------------------------------------------------ messages */

/** Turn a database row into the shape the renderer expects. */
function norm(r) {
  return {
    id: r.id,
    from: r.sender_name,
    mine: r.sender === myId,
    type: r.kind,
    text: r.body,
    audioPath: r.audio_path,
    duration: r.duration || 0,
    peaks: r.peaks || [],
    imagePath: r.image_path,
    remoteUrl: r.remote_url,
    width: r.width || 0,
    height: r.height || 0,
    reaction: r.reaction || '',
    deleted: !!r.deleted,
    at: new Date(r.created_at).getTime(),
  };
}

// Realtime is subscribed before the first read, so anything arriving during
// the initial query is held here and replayed once the thread is painted.
let buffered = [];
let painted = false;

async function subscribe() {
  await new Promise((resolve) => {
    sb.channel('messages-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (p) => {
        const row = p.new;
        if (!row) return;
        if (!painted) buffered.push(row);
        else applyRow(row);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'members' }, (p) => {
        if (p.new && p.new.email !== myEmail) {
          peer = p.new;
          renderPeer();
        }
      })
      .subscribe((status) => status === 'SUBSCRIBED' && resolve());
  });
}

function applyRow(row) {
  const msg = norm(row);
  if (byId.has(msg.id)) updateMessage(msg);
  else {
    addMessage(msg);
    lastId = Math.max(lastId, msg.id);
    if (!msg.mine) {
      ping();
      if (document.visibilityState === 'visible') markRead();
    }
    if (scrollPinned) scrollDown();
  }
}

async function loadMessages() {
  const { data, error } = await sb
    .from('messages')
    .select('*')
    .order('id', { ascending: true })
    .limit(1000);

  if (error) return toast('Could not load the conversation');

  for (const row of data) {
    addMessage(norm(row));
    lastId = Math.max(lastId, row.id);
  }
  painted = true;
  buffered.forEach(applyRow);
  buffered = [];
  scrollDown(true);
  markRead();
}

/* --------------------------------------------------------- rendering */

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
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, new Date(today.getTime() - 864e5))) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function addMessage(msg) {
  if (byId.has(msg.id)) return;
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
  row.className = `row ${msg.mine ? 'out' : 'in'} tail`;
  row.dataset.id = msg.id;

  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = clock(msg.at);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  paintBubble(bubble, msg);

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

  row.append(msg.mine ? time : bubble, msg.mine ? bubble : time);

  row.dataset.from = msg.from;
  if (lastRow?.dataset.from === msg.from) lastRow.classList.remove('tail');
  lastRow = row;

  $('thread').append(row);
  byId.set(msg.id, { msg, el: row, bubble });
}

function paintBubble(bubble, msg) {
  bubble.replaceChildren();
  bubble.classList.toggle('deleted', msg.deleted);

  if (msg.deleted) {
    bubble.classList.remove('photo');
    bubble.textContent = msg.mine ? 'You unsent a message' : 'Unsent a message';
    return;
  }
  if (msg.type === 'voice') {
    bubble.append(voiceBody(msg));
    return;
  }
  if (msg.type === 'photo' || msg.type === 'gif') {
    bubble.classList.add('photo');
    bubble.append(photoBody(msg));
    return;
  }
  bubble.textContent = msg.text;
  // A message that's nothing but emoji deserves to be big.
  if (/^\p{Extended_Pictographic}{1,3}$/u.test((msg.text || '').trim())) {
    bubble.style.fontSize = '38px';
    bubble.style.background = 'none';
    bubble.style.padding = '2px 8px';
  }
}

function updateMessage(patch) {
  const entry = byId.get(patch.id);
  if (!entry) return;
  const { msg, bubble, el } = entry;

  if (patch.deleted && !msg.deleted) {
    msg.deleted = true;
    paintBubble(bubble, msg);
  }

  if (patch.reaction !== msg.reaction) {
    msg.reaction = patch.reaction;
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

/** Media lives in private buckets, so it needs a short-lived signed URL. */
async function signedUrl(bucket, path) {
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

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
  dur.textContent = mmss(msg.duration);

  const paint = (ratio) => {
    const upto = Math.round(ratio * bars.length);
    bars.forEach((b, i) => b.classList.toggle('on', i < upto));
  };

  let audio = null;

  async function ensureAudio() {
    if (audio) return audio;
    audio = new Audio(await signedUrl('voice', msg.audioPath));
    audio.preload = 'auto';
    audio.onplay = () => (play.textContent = '❚❚');
    audio.onpause = () => (play.textContent = '▶');
    audio.ontimeupdate = () => {
      const total = isFinite(audio.duration) && audio.duration ? audio.duration : msg.duration || 1;
      dur.textContent = mmss(Math.max(0, total - audio.currentTime));
      paint(audio.currentTime / total);
    };
    audio.onended = () => {
      play.textContent = '▶';
      dur.textContent = mmss(msg.duration);
      paint(0);
      audio.currentTime = 0;
    };
    return audio;
  }

  play.onclick = async (e) => {
    e.stopPropagation();
    try {
      const a = await ensureAudio();
      document.querySelectorAll('audio').forEach((o) => o !== a && o.pause());
      if (a.paused) await a.play();
      else a.pause();
    } catch {
      toast('Could not play that clip');
    }
  };

  wave.onclick = async (e) => {
    const a = await ensureAudio();
    const r = wave.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const total = isFinite(a.duration) && a.duration ? a.duration : msg.duration || 0;
    if (total) a.currentTime = ratio * total;
    paint(ratio);
  };

  wrap.append(play, wave, dur);
  return wrap;
}

/* ------------------------------------------------------- photo bubble */

function photoBody(msg) {
  const frame = document.createElement('div');
  frame.className = 'frame loading';
  // Hold the right shape before the bytes arrive, so the thread doesn't jump.
  if (msg.width && msg.height) frame.style.aspectRatio = `${msg.width} / ${msg.height}`;

  const img = document.createElement('img');
  img.alt = 'photo';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.onload = () => {
    frame.classList.remove('loading');
    frame.style.aspectRatio = '';
    if (scrollPinned) scrollDown();
  };

  // Picker GIFs are hotlinked; uploads need a signed URL first.
  if (msg.remoteUrl) {
    img.src = msg.remoteUrl;
  } else {
    signedUrl('photos', msg.imagePath)
      .then((url) => (img.src = url))
      .catch(() => {
        frame.classList.remove('loading');
        frame.textContent = 'Photo unavailable';
      });
  }

  img.onclick = (e) => {
    e.stopPropagation();
    $('lightboxImg').src = img.src;
    $('lightbox').hidden = false;
  };

  frame.append(img);
  return frame;
}

$('lightbox').onclick = () => {
  $('lightbox').hidden = true;
  $('lightboxImg').removeAttribute('src');
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('lightbox').hidden) $('lightbox').click();
});

/* --------------------------------------------------------- send photo */

const MAX_DIM = 1600;

/**
 * Phone photos are 4–8MB, which is slow to send and eats the free storage
 * tier. Re-encode to something that still looks good on a phone screen.
 * GIFs pass through untouched so they keep animating.
 */
async function shrink(file) {
  if (file.type === 'image/gif' && file.size < 4e6) {
    const probe = await loadBitmap(file);
    return { blob: file, width: probe.width, height: probe.height, type: file.type };
  }

  const bmp = await loadBitmap(file);
  const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();

  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
  if (!blob) throw new Error('encode failed');
  return { blob, width: w, height: h, type: 'image/jpeg' };
}

/** createImageBitmap where available, <img> everywhere else. */
async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file);
    } catch {
      /* HEIC and friends — fall through */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

async function sendPhoto(file) {
  if (!file || !file.type.startsWith('image/')) return toast('That is not an image');
  if (file.size > 25e6) return toast('That picture is too big');

  let shrunk;
  try {
    shrunk = await shrink(file);
  } catch {
    return toast('Could not read that picture');
  }

  const ext = shrunk.type === 'image/gif' ? 'gif' : 'jpg';
  const path = `${myId}/${crypto.randomUUID()}.${ext}`;

  const up = await sb.storage.from('photos').upload(path, shrunk.blob, {
    contentType: shrunk.type,
    upsert: false,
  });
  if (up.error) return toast('Picture failed to upload');

  const { error } = await sb.from('messages').insert({
    sender: myId,
    sender_name: myName,
    kind: 'photo',
    image_path: path,
    width: shrunk.width,
    height: shrunk.height,
  });

  if (error) {
    sb.storage.from('photos').remove([path]);
    toast('Picture failed to send');
  }
}

/* --------------------------------------------------- profile pictures */

const AVATAR_PX = 256;

/** Centre-crop to a square so it fills the circle without distortion. */
async function squareCrop(file) {
  const bmp = await loadBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_PX;
  canvas
    .getContext('2d')
    .drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
  bmp.close?.();

  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  if (!blob) throw new Error('encode failed');
  return blob;
}

/** Show a member's picture in a circle, falling back to their emoji. */
async function paintAvatar(el, member) {
  if (!member?.avatar_url) {
    el.textContent = member?.avatar || '♥';
    return;
  }
  try {
    const url = await signedUrl('photos', member.avatar_url);
    const img = document.createElement('img');
    img.alt = member.display_name || '';
    img.src = url;
    el.replaceChildren(img);
  } catch {
    el.textContent = member?.avatar || '♥';
  }
}

$('btnMe').onclick = () => $('avatarInput').click();

$('avatarInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !file.type.startsWith('image/')) return;

  let blob;
  try {
    blob = await squareCrop(file);
  } catch {
    return toast('Could not read that picture');
  }

  // A fresh path each time, so no storage UPDATE policy is needed.
  const path = `avatars/${myId}/${crypto.randomUUID()}.jpg`;
  const up = await sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg' });
  if (up.error) return toast('Picture failed to upload');

  const previous = mine?.avatar_url;
  const { error } = await sb
    .from('members')
    .update({ avatar_url: path, updated_at: new Date().toISOString() })
    .eq('email', myEmail);

  if (error) {
    sb.storage.from('photos').remove([path]);
    return toast('Could not save your picture');
  }

  if (mine) mine.avatar_url = path;
  paintAvatar($('btnMe'), mine);
  if (previous) sb.storage.from('photos').remove([previous]); // tidy up the old one
  toast('Picture updated');
});

$('btnPhoto').onclick = () => $('fileInput').click();
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // let the same file be picked twice
  if (file) await sendPhoto(file);
});

// Paste a screenshot straight into the conversation.
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  if (file) sendPhoto(file);
});

/* ----------------------------------------------------------- gifs */

/* Picker GIFs are hotlinked from Giphy's CDN rather than copied into storage:
   they stay animated, cost nothing, and Giphy's assets are public anyway. */

const GIPHY = cfg.GIPHY_API_KEY;
if (GIPHY) $('btnGif').hidden = false;

let gifTimer = null;
let gifSeq = 0;

async function loadGifs(query) {
  const seq = ++gifSeq;
  const status = $('gifStatus');
  status.textContent = 'Loading…';

  const endpoint = query
    ? `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY}&limit=24&rating=pg-13&q=${encodeURIComponent(query)}`
    : `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY}&limit=24&rating=pg-13`;

  let items;
  try {
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(res.status);
    items = (await res.json()).data || [];
  } catch {
    if (seq === gifSeq) status.textContent = 'Could not reach Giphy — check the API key.';
    return;
  }

  if (seq !== gifSeq) return; // a newer search already came back
  const grid = $('gifResults');
  grid.replaceChildren();
  status.textContent = items.length ? '' : 'Nothing found.';

  for (const g of items) {
    const preview = g.images?.fixed_width_small || g.images?.fixed_width;
    const full = g.images?.downsized_medium || g.images?.original;
    if (!preview?.url || !full?.url) continue;

    const img = document.createElement('img');
    img.src = preview.url;
    img.alt = g.title || 'GIF';
    img.loading = 'lazy';
    img.onclick = () => sendGif(full);
    grid.append(img);
  }
}

async function sendGif(image) {
  closeGifPanel();
  const { error } = await sb.from('messages').insert({
    sender: myId,
    sender_name: myName,
    kind: 'gif',
    remote_url: image.url,
    width: Number(image.width) || null,
    height: Number(image.height) || null,
  });
  if (error) toast('GIF failed to send');
}

function openGifPanel() {
  $('gifPanel').hidden = false;
  $('gifSearch').value = '';
  loadGifs('');
  if (!matchMedia('(hover: none)').matches) $('gifSearch').focus();
}

function closeGifPanel() {
  $('gifPanel').hidden = true;
  gifSeq++; // abandon any in-flight search
}

$('btnGif').onclick = () => ($('gifPanel').hidden ? openGifPanel() : closeGifPanel());
$('gifClose').onclick = closeGifPanel;

$('gifSearch').addEventListener('input', () => {
  clearTimeout(gifTimer);
  gifTimer = setTimeout(() => loadGifs($('gifSearch').value.trim()), 350);
});

/* ---------------------------------------------------------- reactions */

let reactTarget = null;

function openReactions(e, msg) {
  if (msg.deleted) return;
  reactTarget = msg;
  const box = $('reactions');
  box.hidden = false;
  const r = box.getBoundingClientRect();
  box.style.left = `${Math.min(Math.max(8, (e.clientX || 40) - r.width / 2), innerWidth - r.width - 8)}px`;
  box.style.top = `${Math.max(8, (e.clientY || 80) - r.height - 12)}px`;

  box.querySelector('.trash')?.remove();
  if (msg.mine) {
    const t = document.createElement('button');
    t.className = 'trash';
    t.textContent = '🗑';
    t.onclick = () => {
      box.hidden = true;
      unsend(msg);
    };
    box.append(t);
  }
}

$('reactions').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-e]');
  if (!btn || !reactTarget) return;
  $('reactions').hidden = true;
  const emoji = btn.dataset.e === reactTarget.reaction ? '' : btn.dataset.e;
  const { error } = await sb.from('messages').update({ reaction: emoji }).eq('id', reactTarget.id);
  if (error) toast('Could not react');
});

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#reactions') && !e.target.closest('.bubble')) $('reactions').hidden = true;
});

async function unsend(msg) {
  const { error } = await sb.from('messages').update({ deleted: true }).eq('id', msg.id);
  if (error) return toast('Could not unsend');
  // Best effort — the row is already marked, so a failure here just leaves an
  // orphaned file that nothing links to.
  if (msg.audioPath) sb.storage.from('voice').remove([msg.audioPath]);
  if (msg.imagePath) sb.storage.from('photos').remove([msg.imagePath]);
}

/* ------------------------------------------------------------- toast */

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2800);
}

/* --------------------------------------------------------- send text */

async function sendText() {
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  setTyping(false);

  const { error } = await sb.from('messages').insert({
    sender: myId,
    sender_name: myName,
    kind: 'text',
    body: text,
  });

  if (error) {
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

let typingOn = false;
let typingTimer;
function setTyping(on) {
  if (on === typingOn) return;
  typingOn = on;
  room?.track({ name: myName, typing: on });
}

$('input').addEventListener('input', () => {
  setTyping(!!$('input').value);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => setTyping(false), 4000);
});

/* ------------------------------------------------------ voice mails */

let rec = null;
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
  recorder.onstop = () => finishRecording();
  recorder.start();

  rec = { recorder, chunks, stream, startedAt: Date.now(), locked: false, cancelled: false };

  $('recBar').hidden = false;
  $('btnMic').classList.add('recording');
  tickTimer();
  liveWave(stream);
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
    const slice = history.slice(-Math.floor(w / (barW + gap)));

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
  $('recBar').querySelector('.rec-hint').textContent = 'release to send';
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

  const type = r.recorder.mimeType || 'audio/webm';
  const blob = new Blob(r.chunks, { type });
  if (!blob.size) return toast('Nothing was recorded');

  const peaks = await peaksFrom(blob);
  const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
  const path = `${myId}/${crypto.randomUUID()}.${ext}`;

  const up = await sb.storage.from('voice').upload(path, blob, {
    contentType: type.split(';')[0],
    upsert: false,
  });
  if (up.error) return toast('Voice mail failed to upload');

  const { error } = await sb.from('messages').insert({
    sender: myId,
    sender_name: myName,
    kind: 'voice',
    audio_path: path,
    duration: seconds,
    peaks,
  });

  if (error) {
    sb.storage.from('voice').remove([path]);
    toast('Voice mail failed to send');
  }
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

/* -------------------------------------------------- presence & status */

function joinRoom() {
  room = sb.channel('room', { config: { presence: { key: myId } } });

  room
    .on('presence', { event: 'sync' }, () => {
      const state = room.presenceState();
      const others = Object.entries(state).filter(([k]) => k !== myId);
      peerOnline = others.length > 0;
      peerTyping = others.some(([, metas]) => metas.some((m) => m.typing));
      renderPeer();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await room.track({ name: myName, typing: false });
    });
}

let paintedPeerAvatar = null;

function renderPeer() {
  $('peerAvatar').classList.toggle('online', peerOnline);
  $('peerName').textContent = peer?.display_name || 'Waiting for her…';

  // Presence syncs often; only re-sign the URL when the picture actually changes.
  const key = peer ? `${peer.avatar_url || ''}|${peer.avatar || ''}` : '';
  if (key !== paintedPeerAvatar) {
    paintedPeerAvatar = key;
    paintAvatar($('peerAvatar'), peer);
  }

  const status = $('peerStatus');
  status.classList.toggle('on', peerOnline);
  if (peerTyping) status.textContent = 'typing…';
  else if (peerOnline) status.textContent = 'Active now';
  else if (peer?.updated_at) status.textContent = `Active ${ago(new Date(peer.updated_at).getTime())}`;
  else status.textContent = 'offline';

  $('typing').hidden = !peerTyping;
  if (peerTyping && scrollPinned) scrollDown();
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
  if (!peer?.last_read) return;
  const sent = [...byId.values()].filter((e) => e.msg.mine);
  const last = sent[sent.length - 1];
  if (!last || peer.last_read < last.msg.id) return;
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

let readSent = 0;
function markRead() {
  if (!lastId || lastId === readSent) return;
  readSent = lastId;
  sb.from('members')
    .update({ last_read: lastId, updated_at: new Date().toISOString() })
    .eq('email', myEmail)
    .then(() => {}, () => {});
}

/** Keeps "Active 5m ago" honest for whoever is offline. */
function heartbeat() {
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    sb.from('members')
      .update({ updated_at: new Date().toISOString() })
      .eq('email', myEmail)
      .then(() => {}, () => {});
  }, 45000);
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
  if (window.Notification?.permission === 'granted') {
    new Notification(`${peer?.display_name || 'She'} sent you something 💌`);
  }
}

if ('Notification' in window && Notification.permission === 'default') {
  document.addEventListener('click', () => Notification.requestPermission(), { once: true });
}
