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
  applyRoom(); // the background veil is palette-dependent
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

/* --------------------------------------------------- re-lock when hidden */

/* Choosing a file, taking a photo or granting the microphone hands control
   to the OS, which hides the page. That is us, not the user walking away —
   locking there would strand them mid-upload. */
let osDialogOpen = false;

function viaOsDialog(input) {
  osDialogOpen = true;
  input.click();
}

window.addEventListener('focus', () => setTimeout(() => (osDialogOpen = false), 800));

let lockTimer = null;

function relock() {
  sessionStorage.removeItem('vamor.unlocked');
  clearTimeout(idleTimer);
  if ($('chat').hidden) return; // already away from the conversation
  closePanels();
  $('lightbox').hidden = true;
  $('reactions').hidden = true;
  $('passphrase').value = '';
  $('lockError').hidden = true;
  show('lock');
}

/* ------------------------------------------------------- idle locking */

const IDLE_MS = Math.max(0, Number(cfg.IDLE_LOCK_MINUTES) || 0) * 60000;
let idleTimer = null;

/** Don't lock out from under someone mid voice note or mid video. */
function mediaBusy() {
  if (rec) return true;
  return [...document.querySelectorAll('audio, video')].some((m) => !m.paused && !m.ended);
}

function resetIdle() {
  if (!IDLE_MS || !lockRequired()) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(onIdle, IDLE_MS);
}

function onIdle() {
  if ($('chat').hidden) return; // already locked or signed out
  if (mediaBusy()) return resetIdle(); // check again after another interval
  relock();
}

for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel', 'focus']) {
  window.addEventListener(ev, resetIdle, { passive: true });
}

document.addEventListener('visibilitychange', () => {
  if (!lockRequired() || cfg.LOCK_ON_HIDE === false) return;

  if (document.visibilityState === 'hidden') {
    if (osDialogOpen) return;
    const grace = Math.max(0, Number(cfg.LOCK_GRACE_SECONDS) || 0) * 1000;
    clearTimeout(lockTimer);
    lockTimer = grace ? setTimeout(relock, grace) : (relock(), null);
  } else {
    clearTimeout(lockTimer); // came back inside the grace period
  }
});

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

/** Never let a stalled request leave the splash spinning forever. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

async function start(session) {
  try {
    await startInner(session);
  } catch (err) {
    stuck(err?.message || 'Something went wrong while opening the chat.');
  }
}

/** Splash is a dead end when something fails, so give it a way out. */
function stuck(message) {
  show('auth');
  $('emailForm').hidden = true;
  $('codeForm').hidden = true;
  $('authNote').hidden = false;
  $('authNote').textContent = message;
  $('authError').hidden = false;
  $('authError').innerHTML =
    '<button id="retry" class="btn-link">Try again</button> · ' +
    '<button id="bail" class="btn-link">Sign out</button>';
  $('retry').onclick = () => location.reload();
  $('bail').onclick = async () => {
    await sb.auth.signOut();
    location.reload();
  };
}

// If we are still on the splash well after load, something silently stalled.
setTimeout(() => {
  if (!$('splash').hidden) stuck('This is taking longer than it should.');
}, 12000);

window.addEventListener('unhandledrejection', (e) => {
  console.error('unhandled', e.reason);
  if (!$('splash').hidden) stuck(String(e.reason?.message || e.reason || 'Unexpected error'));
});

async function startInner(session) {
  myId = session.user.id;
  myEmail = (session.user.email || '').toLowerCase();
  show('splash');

  // The `members` table is the allowlist. If RLS hides it, you're not on it.
  const { data: members, error } = await withTimeout(
    sb.from('members').select('*'),
    15000,
    'Loading your profile'
  );

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
  paintSelf();

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
  resetIdle();
  if (chatStarted) return;
  chatStarted = true;

  await subscribe();
  await loadRoom();
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
    senderId: r.sender,
    mine: r.sender === myId,
    replyTo: r.reply_to,
    editedAt: r.edited_at,
    type: r.kind,
    text: r.body,
    audioPath: r.audio_path,
    duration: r.duration || 0,
    peaks: r.peaks || [],
    imagePath: r.image_path,
    videoPath: r.video_path,
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
let everConnected = false;

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
        if (!p.new) return;
        if (p.new.email === myEmail) {
          mine = p.new; // another device of yours changed your name or picture
          myName = mine.display_name;
          paintSelf();
        } else {
          peer = p.new;
          renderPeer();
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'room' }, (p) => {
        if (p.new) {
          look = p.new;
          applyRoom();
        }
      })
      // Resolve on failure too. A realtime channel that cannot connect must
      // not block the conversation from being read — it only costs live
      // updates, and the initial load still works.
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // Reconnecting after a drop means we missed whatever happened in
          // between, so re-read rather than silently continuing.
          if (everConnected) catchUp();
          everConnected = true;
          return resolve();
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.warn('realtime:', status);
          resolve();
        }
      });

    setTimeout(resolve, 8000); // belt and braces: never wait forever
  });
}

function applyRow(row) {
  const msg = norm(row);
  if (byId.has(msg.id)) return updateMessage(msg);

  allMsgs.push(msg);
  addMessage(msg);
  lastId = Math.max(lastId, msg.id);
  if (!msg.mine) {
    ping();
    if (document.visibilityState === 'visible') markRead();
  }
  if (scrollPinned) scrollDown();
}

/* A page at a time, newest first. Reading the oldest N instead would mean
   that past N messages the app stops showing anything recent. */
const PAGE = 150;

/** Every message currently held in memory, ascending by id. */
let allMsgs = [];
let oldestLoaded = null;
let loadingOlder = false;

async function loadMessages() {
  const { data, error } = await sb
    .from('messages')
    .select('*')
    .order('id', { ascending: false })
    .limit(PAGE);

  if (error) return toast('Could not load the conversation');

  const rows = data.reverse(); // back to oldest-first for rendering
  allMsgs = rows.map(norm);
  oldestLoaded = allMsgs.length ? allMsgs[0].id : null;

  for (const msg of allMsgs) {
    addMessage(msg);
    lastId = Math.max(lastId, msg.id);
  }

  painted = true;
  buffered.forEach(applyRow);
  buffered = [];
  updateOlderButton();
  scrollDown(true);
  markRead();
}

/** Rebuild the thread from allMsgs, holding the reader's place. */
function renderThread() {
  const thread = $('thread');
  const heightBefore = thread.scrollHeight;
  const topBefore = thread.scrollTop;

  for (const child of [...thread.children]) {
    if (child.id !== 'empty' && child.id !== 'olderRow') child.remove();
  }
  byId.clear();
  lastRow = null;

  for (const msg of allMsgs) addMessage(msg);

  // Growth happened above the viewport, so shift down by exactly that much.
  thread.scrollTop = topBefore + (thread.scrollHeight - heightBefore);
}

async function loadOlder() {
  if (loadingOlder || oldestLoaded == null) return;
  loadingOlder = true;
  $('olderBtn').textContent = 'Loading…';

  const { data, error } = await sb
    .from('messages')
    .select('*')
    .lt('id', oldestLoaded)
    .order('id', { ascending: false })
    .limit(PAGE);

  loadingOlder = false;
  $('olderBtn').textContent = 'Load earlier messages';

  if (error) return toast('Could not load earlier messages');
  if (!data.length) {
    oldestLoaded = null;
    return updateOlderButton();
  }

  allMsgs = [...data.reverse().map(norm), ...allMsgs];
  oldestLoaded = allMsgs[0].id;
  renderThread();
  updateOlderButton();
}

function updateOlderButton() {
  // Only worth offering once a full page came back — a shorter first page
  // means we already have the whole conversation.
  $('olderRow').hidden = oldestLoaded == null || allMsgs.length < PAGE;
}

$('olderBtn').onclick = loadOlder;

/**
 * Realtime only pushes what happens while connected. After a sleep, a dropped
 * socket or a network change, anything sent in between would be missed
 * entirely, so re-read on the way back.
 */
async function catchUp() {
  if (!chatStarted || document.visibilityState !== 'visible') return;

  const { data, error } = await sb
    .from('messages')
    .select('*')
    .order('id', { ascending: false })
    .limit(PAGE);
  if (error || !data) return;

  const rows = data.reverse();

  // More was missed than one page holds — start clean rather than leave a gap.
  if (rows.length === PAGE && rows[0].id > lastId + 1) {
    allMsgs = [];
    byId.clear();
    lastRow = null;
    for (const child of [...$('thread').children]) {
      if (child.id !== 'empty' && child.id !== 'olderRow') child.remove();
    }
    lastId = 0;
    return loadMessages();
  }

  // Re-applying known rows is how reactions and edits made while away land.
  rows.forEach(applyRow);
}

document.addEventListener('visibilitychange', catchUp);
window.addEventListener('online', catchUp);

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

  // Desktop affordance for the menu that long-press/right-click gives on phone.
  const more = document.createElement('button');
  more.className = 'more-btn';
  more.title = 'More';
  more.setAttribute('aria-label', 'Message actions');
  more.textContent = '⋯';
  more.onclick = (e) => {
    e.stopPropagation();
    openReactions(e, msg);
  };

  if (msg.mine) row.append(more, time, bubble);
  else row.append(bubble, time, more);

  // Group by sender id, not name — names are editable.
  row.dataset.from = msg.senderId;
  if (lastRow?.dataset.from === msg.senderId) lastRow.classList.remove('tail');
  lastRow = row;

  $('thread').append(row);
  byId.set(msg.id, { msg, el: row, bubble });
}

/** One line describing a message, for reply quotes and the composer bar. */
function preview(msg) {
  if (!msg) return 'message';
  if (msg.deleted) return 'unsent message';
  if (msg.type === 'voice') return '🎙 Voice mail';
  if (msg.type === 'video') return '🎬 Video';
  if (msg.type === 'photo') return '🖼 Photo';
  if (msg.type === 'gif') return 'GIF';
  return msg.text || '';
}

const nameOf = (msg) => (msg?.mine ? 'You' : peer?.display_name || msg?.from || 'Her');

function quoteBlock(msg) {
  const target = byId.get(msg.replyTo)?.msg;
  const q = document.createElement('button');
  q.type = 'button';
  q.className = 'quote';

  const who = document.createElement('b');
  who.textContent = target ? nameOf(target) : 'Message';
  const what = document.createElement('span');
  what.textContent = target ? preview(target) : 'no longer available';

  q.append(who, what);
  q.onclick = (e) => {
    e.stopPropagation();
    jumpTo(msg.replyTo);
  };
  return q;
}

/** Scroll a quoted message into view and flash it. */
function jumpTo(id) {
  const entry = byId.get(id);
  if (!entry) return;
  entry.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  entry.el.classList.remove('flash');
  void entry.el.offsetWidth; // restart the animation
  entry.el.classList.add('flash');
  setTimeout(() => entry.el.classList.remove('flash'), 1200);
}

function paintBubble(bubble, msg) {
  bubble.replaceChildren();
  bubble.classList.toggle('deleted', msg.deleted);

  if (msg.deleted) {
    bubble.classList.remove('photo');
    bubble.textContent = msg.mine ? 'You unsent a message' : 'Unsent a message';
    return;
  }

  if (msg.replyTo) bubble.append(quoteBlock(msg));
  if (msg.type === 'voice') {
    bubble.append(voiceBody(msg));
    return;
  }
  if (msg.type === 'video') {
    bubble.classList.add('photo');
    bubble.append(videoBody(msg));
    return;
  }
  if (msg.type === 'photo' || msg.type === 'gif') {
    bubble.classList.add('photo');
    bubble.append(photoBody(msg));
    return;
  }
  // A text node would be wiped by the quote block, so keep the body in a span.
  const body = document.createElement('span');
  body.textContent = msg.text;
  bubble.append(body);

  // A message that's nothing but emoji deserves to be big.
  const bare = !msg.replyTo && /^\p{Extended_Pictographic}{1,3}$/u.test((msg.text || '').trim());
  bubble.style.fontSize = bare ? '38px' : '';
  bubble.style.background = bare ? 'none' : '';
  bubble.style.padding = bare ? '2px 8px' : '';

  if (msg.editedAt) {
    const tag = document.createElement('span');
    tag.className = 'edited';
    tag.textContent = 'edited';
    bubble.append(tag);
  }
}

function updateMessage(patch) {
  const entry = byId.get(patch.id);
  if (!entry) return;
  const { msg, bubble, el } = entry;

  if (patch.deleted && !msg.deleted) {
    msg.deleted = true;
    paintBubble(bubble, msg);
  } else if (patch.text !== msg.text || patch.editedAt !== msg.editedAt) {
    msg.text = patch.text;
    msg.editedAt = patch.editedAt;
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

/* Media lives in private buckets, so it needs a signed URL. Minting a fresh
   one every time defeats the browser cache — a new URL looks like a new file,
   so every reload re-downloads every photo. Reuse them until they near
   expiry, and keep them across reloads, so the cache actually works. */

const SIGNED_TTL = 6 * 3600; // seconds
const urlCache = new Map();

try {
  const saved = JSON.parse(localStorage.getItem('vamor.urls') || '{}');
  for (const [k, v] of Object.entries(saved)) {
    if (v.expires > Date.now()) urlCache.set(k, v);
  }
} catch {
  /* corrupt or absent — start empty */
}

let cacheFlush = null;
function persistUrls() {
  clearTimeout(cacheFlush);
  cacheFlush = setTimeout(() => {
    try {
      localStorage.setItem('vamor.urls', JSON.stringify(Object.fromEntries(urlCache)));
    } catch {
      urlCache.clear(); // quota — drop it rather than wedge
    }
  }, 500);
}

async function signedUrl(bucket, path) {
  const key = `${bucket}/${path}`;
  const hit = urlCache.get(key);
  // A minute of headroom, so a URL can't expire mid-download.
  if (hit && hit.expires > Date.now() + 60000) return hit.url;

  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, SIGNED_TTL);
  if (error) throw error;

  urlCache.set(key, { url: data.signedUrl, expires: Date.now() + SIGNED_TTL * 1000 });
  persistUrls();
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

$('lightbox').onclick = (e) => {
  if (e.target.closest('#lightboxSave')) return;
  $('lightbox').hidden = true;
  $('lightboxImg').removeAttribute('src');
};

$('lightboxSave').onclick = (e) => {
  e.stopPropagation();
  const src = $('lightboxImg').src;
  if (src) saveFile(src, `vamor-${Date.now()}.jpg`);
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('lightbox').hidden) $('lightbox').click();
});

/* ------------------------------------------------------- video bubble */

/* Starts as a poster frame with a play badge. The clip itself is only
   fetched once you actually press play, so opening the chat never pulls
   down tens of megabytes. */
function videoBody(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'frame video-poster';
  if (msg.width && msg.height) wrap.style.aspectRatio = `${msg.width} / ${msg.height}`;

  const poster = document.createElement('img');
  poster.alt = 'video';
  poster.loading = 'lazy';
  if (msg.imagePath) signedUrl('photos', msg.imagePath).then((u) => (poster.src = u)).catch(() => {});

  const badge = document.createElement('div');
  badge.className = 'play-badge';
  badge.textContent = '▶';

  const len = document.createElement('span');
  len.className = 'video-len';
  len.textContent = mmss(msg.duration || 0);

  wrap.append(poster, badge, len);

  wrap.onclick = async (e) => {
    e.stopPropagation();
    try {
      const url = await signedUrl('videos', msg.videoPath);
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      if (poster.src) video.poster = poster.src;
      wrap.replaceWith(video);
    } catch {
      toast('Could not open that video');
    }
  };

  return wrap;
}

/* ------------------------------------------------------- send video */

/** Grab the first frame so the bubble has something to show. */
function posterFrom(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;

    const done = (result) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };

    v.onloadeddata = () => {
      // A hair past zero — the very first frame is often black.
      v.currentTime = Math.min(0.2, (v.duration || 1) / 2);
    };
    v.onseeked = () => {
      const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(v.videoWidth * scale);
      canvas.height = Math.round(v.videoHeight * scale);
      canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) =>
          done({ blob, width: v.videoWidth, height: v.videoHeight, duration: v.duration || 0 }),
        'image/jpeg',
        0.8
      );
    };
    v.onerror = () => done(null);
    setTimeout(() => done(null), 8000); // never hang on an odd codec
    v.src = url;
  });
}

const VIDEO_LIMIT = 50 * 1024 * 1024;

async function sendVideo(file) {
  if (!file || !file.type.startsWith('video/')) return toast('That is not a video');
  if (file.size > VIDEO_LIMIT) {
    return toast(`That video is ${(file.size / 1048576).toFixed(0)}MB — the limit is 50MB`);
  }

  toast('Uploading video…');
  const meta = await posterFrom(file);

  // The video itself is never re-encoded, so quality is exactly the original.
  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().slice(0, 5);
  const path = `${myId}/${crypto.randomUUID()}.${ext}`;
  const up = await sb.storage.from('videos').upload(path, file, { contentType: file.type });
  if (up.error) return toast('Video failed to upload');

  let posterPath = null;
  if (meta?.blob) {
    posterPath = `posters/${myId}/${crypto.randomUUID()}.jpg`;
    const p = await sb.storage.from('photos').upload(posterPath, meta.blob, {
      contentType: 'image/jpeg',
    });
    if (p.error) posterPath = null;
  }

  const { error } = await sb.from('messages').insert({
    sender: myId,
    sender_name: myName,
    kind: 'video',
    video_path: path,
    image_path: posterPath,
    width: meta?.width || null,
    height: meta?.height || null,
    duration: meta?.duration || null,
    reply_to: takeReply(),
  });

  if (error) {
    sb.storage.from('videos').remove([path]);
    if (posterPath) sb.storage.from('photos').remove([posterPath]);
    toast('Video failed to send');
  }
}

$('sideVideo').onclick = () => viaOsDialog($('videoInput'));
$('videoInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) await sendVideo(file);
});

/* ------------------------------------------------------- saving media */

/* Cross-origin URLs ignore the download attribute, so fetch the bytes and
   hand the browser a local blob instead. */
async function saveFile(url, filename) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  } catch {
    toast('Could not save that file');
  }
}

/** Resolve whatever a media message points at into a URL plus a filename. */
async function mediaUrl(msg) {
  if (msg.type === 'gif') return { url: msg.remoteUrl, name: `vamor-${msg.id}.gif` };
  if (msg.type === 'video') {
    return { url: await signedUrl('videos', msg.videoPath), name: `vamor-${msg.id}.mp4` };
  }
  return { url: await signedUrl('photos', msg.imagePath), name: `vamor-${msg.id}.jpg` };
}

async function saveMedia(msg) {
  try {
    const { url, name } = await mediaUrl(msg);
    await saveFile(url, name);
  } catch {
    toast('Could not save that file');
  }
}

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
    reply_to: takeReply(),
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

function openProfile() {
  closePanels();
  $('nameInput').value = mine?.display_name || '';
  paintAvatar($('profilePic'), mine);
  $('profilePanel').hidden = false;
}

$('btnMe').onclick = () => ($('profilePanel').hidden ? openProfile() : ($('profilePanel').hidden = true));
$('profileClose').onclick = () => ($('profilePanel').hidden = true);
$('profilePic').onclick = () => viaOsDialog($('avatarInput'));
$('profilePicBtn').onclick = () => viaOsDialog($('avatarInput'));

$('profileSave').onclick = async () => {
  const name = $('nameInput').value.trim().slice(0, 24);
  if (!name) return toast('Pick a name');
  if (name === mine?.display_name) return ($('profilePanel').hidden = true);

  const { error } = await sb
    .from('members')
    .update({ display_name: name, updated_at: new Date().toISOString() })
    .eq('email', myEmail);

  if (error) return toast('Could not save your name');
  if (mine) mine.display_name = name;
  myName = name;
  $('profilePanel').hidden = true;
  toast('Name updated');
};

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
  paintSelf();
  paintAvatar($('profilePic'), mine);
  if (previous) sb.storage.from('photos').remove([previous]); // tidy up the old one
  toast('Picture updated');
});

$('btnPhoto').onclick = () => viaOsDialog($('fileInput'));
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

/* ------------------------------------------------------- chat theme */

/* The look is shared: it lives in the single `room` row, so whichever of you
   changes it, both see it. */

const THEMES = [
  { id: 'default', a: '#ff5d8f', b: '#b445ff' },
  { id: 'ocean', a: '#2f9bff', b: '#6a5bff' },
  { id: 'sunset', a: '#ff8a3d', b: '#ff4d7d' },
  { id: 'forest', a: '#2fbf71', b: '#1d8f9c' },
  { id: 'candy', a: '#ff5fd2', b: '#7a5cff' },
  { id: 'midnight', a: '#4a5fd0', b: '#8b45ff' },
  { id: 'mono', a: '#6b7280', b: '#374151' },
];

let look = { theme: 'default', bg_path: null };

function applyRoom() {
  document.documentElement.dataset.chatTheme = look.theme || 'default';
  [...$('swatches').children].forEach((s) => s.classList.toggle('on', s.dataset.id === look.theme));
  $('bgClear').hidden = !look.bg_path;

  $('dim').value = look.bg_dim ?? 0.45;
  $('dimRow').hidden = !look.bg_path;

  const shell = $('main');
  if (!look.bg_path) {
    shell.style.backgroundImage = '';
    shell.classList.remove('has-bg');
    return;
  }
  signedUrl('photos', look.bg_path)
    .then((url) => {
      shell.style.backgroundImage = `linear-gradient(${veilColor()}, ${veilColor()}), url("${url}")`;
      shell.classList.add('has-bg');
    })
    .catch(() => {
      shell.style.backgroundImage = '';
      shell.classList.remove('has-bg');
    });
}

/** The veil has to match the current light/dark palette, not a fixed colour. */
function veilColor() {
  const dim = Math.min(0.9, Math.max(0, look.bg_dim ?? 0.45));
  const dark = document.documentElement.dataset.theme === 'dark';
  return dark ? `rgba(11, 16, 32, ${dim})` : `rgba(243, 244, 248, ${dim})`;
}

function buildSwatches() {
  const box = $('swatches');
  box.replaceChildren();
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.id = t.id;
    b.title = t.id;
    b.style.background = `linear-gradient(100deg, ${t.a}, ${t.b})`;
    b.onclick = () => saveRoom({ theme: t.id });
    box.append(b);
  }
}

async function saveRoom(patch) {
  look = { ...look, ...patch };
  applyRoom();
  const { error } = await sb
    .from('room')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) toast('Could not save the theme');
}

async function loadRoom() {
  const { data } = await sb.from('room').select('*').eq('id', 1).maybeSingle();
  if (data) look = data;
  buildSwatches();
  applyRoom();
}

$('btnLook').onclick = () => {
  if ($('lookPanel').hidden) {
    closePanels();
    $('lookPanel').hidden = false;
  } else {
    $('lookPanel').hidden = true;
  }
};
$('lookClose').onclick = () => ($('lookPanel').hidden = true);
// Drag freely, but only write the final value to the database.
$('dim').addEventListener('input', () => {
  look.bg_dim = Number($('dim').value);
  applyRoom();
});
$('dim').addEventListener('change', () => saveRoom({ bg_dim: Number($('dim').value) }));

$('bgBtn').onclick = () => viaOsDialog($('bgInput'));
$('bgClear').onclick = async () => {
  const old = look.bg_path;
  await saveRoom({ bg_path: null });
  if (old) sb.storage.from('photos').remove([old]);
};

$('bgInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !file.type.startsWith('image/')) return;

  let shrunk;
  try {
    shrunk = await shrink(file);
  } catch {
    return toast('Could not read that picture');
  }

  const path = `backgrounds/${crypto.randomUUID()}.jpg`;
  const up = await sb.storage.from('photos').upload(path, shrunk.blob, { contentType: shrunk.type });
  if (up.error) return toast('Background failed to upload');

  const old = look.bg_path;
  await saveRoom({ bg_path: path });
  if (old) sb.storage.from('photos').remove([old]);
  $('lookPanel').hidden = true;
});

/* ------------------------------------------------------ shared media */

const MEDIA_KINDS = new Set(['photo', 'video', 'gif']);

async function openMedia() {
  closePanels();
  $('mediaPanel').hidden = false;

  const items = [...byId.values()]
    .map((e) => e.msg)
    .filter((m) => MEDIA_KINDS.has(m.type) && !m.deleted)
    .reverse(); // newest first

  const grid = $('mediaGrid');
  grid.replaceChildren();
  $('mediaEmpty').hidden = items.length > 0;

  for (const msg of items) {
    const cell = document.createElement('button');
    cell.title = 'Open';

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = preview(msg);
    if (msg.type === 'gif') img.src = msg.remoteUrl;
    else if (msg.imagePath) signedUrl('photos', msg.imagePath).then((u) => (img.src = u)).catch(() => {});
    cell.append(img);

    if (msg.type !== 'photo') {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = msg.type === 'video' ? '🎬' : 'GIF';
      cell.append(tag);
    }

    // Jump to it in the conversation, where it can be played or replied to.
    cell.onclick = () => {
      $('mediaPanel').hidden = true;
      jumpTo(msg.id);
    };
    grid.append(cell);
  }
}

$('btnMedia').onclick = () => ($('mediaPanel').hidden ? openMedia() : ($('mediaPanel').hidden = true));
$('mediaClose').onclick = () => ($('mediaPanel').hidden = true);

/* -------------------------------------------------- desktop side rail */

/* The rail duplicates controls that live in the header on phones, so it
   forwards to the same buttons rather than repeating their logic. */
const forward = (from, to) => ($(from).onclick = () => $(to).click());

forward('sideProfile', 'btnMe');
forward('sidePhoto', 'btnPhoto');
forward('sideMedia', 'btnMedia');
forward('sideGif', 'btnGif');
forward('sideLook', 'btnLook');
forward('sideMode', 'btnTheme');
forward('sideSignOut', 'btnSignOut');

/** Keep the rail's copy of your name and picture in step. */
function paintSelf() {
  paintAvatar($('btnMe'), mine);
  paintAvatar($('sideAvatar'), mine);
  $('sideName').textContent = mine?.display_name || 'You';
}

/** Only one sheet open at a time. */
function closePanels() {
  $('profilePanel').hidden = true;
  $('lookPanel').hidden = true;
  $('mediaPanel').hidden = true;
  closeGifPanel();
}

/* ----------------------------------------------------------- gifs */

/* Picker GIFs are hotlinked from Giphy's CDN rather than copied into storage:
   they stay animated, cost nothing, and Giphy's assets are public anyway. */

const GIPHY = cfg.GIPHY_API_KEY;
if (GIPHY) {
  $('btnGif').hidden = false;
  $('sideGif').hidden = false;
}

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
    reply_to: takeReply(),
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

  box.querySelector('.trash')?.remove();
  box.querySelector('.pencil')?.remove();
  box.querySelector('.saver')?.remove();

  // Anything with a file behind it can be kept.
  if (MEDIA_KINDS.has(msg.type)) {
    const s = document.createElement('button');
    s.className = 'tool saver';
    s.title = 'Save to your device';
    s.textContent = '⤓';
    s.onclick = () => {
      box.hidden = true;
      saveMedia(msg);
    };
    box.append(s);
  }

  // Only your own words can be corrected.
  if (msg.mine && msg.type === 'text') {
    const p = document.createElement('button');
    p.className = 'tool pencil';
    p.title = 'Edit';
    p.textContent = '✏';
    p.onclick = () => {
      box.hidden = true;
      startEdit(msg);
    };
    box.append(p);
  }

  if (msg.mine) {
    const t = document.createElement('button');
    t.className = 'tool trash';
    t.title = 'Unsend';
    t.textContent = '🗑';
    t.onclick = () => {
      box.hidden = true;
      unsend(msg);
    };
    box.append(t);
  }

  // Measure only once the buttons are in place, or the box wraps to a
  // different size than the one we positioned.
  const r = box.getBoundingClientRect();
  const x = (e.clientX ?? innerWidth / 2) - r.width / 2;
  const y = (e.clientY ?? 120) - r.height - 12;

  // max() outermost, so an oversized box is pinned on screen rather than
  // pushed off the left edge.
  box.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  box.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
}

$('btnReply').onclick = () => {
  $('reactions').hidden = true;
  if (reactTarget) startReply(reactTarget);
};

/* -------------------------------------------------- reply & edit state */

let replyTo = null; // message being replied to
let editing = null; // message being edited

function showContext(label, snippet) {
  $('contextLabel').textContent = label;
  $('contextSnippet').textContent = snippet;
  $('contextBar').hidden = false;
}

function clearContext() {
  replyTo = null;
  editing = null;
  $('contextBar').hidden = true;
  $('input').value = '';
}

function startReply(msg) {
  editing = null;
  replyTo = msg;
  showContext(`Replying to ${nameOf(msg)}`, preview(msg));
  $('input').focus();
}

function startEdit(msg) {
  replyTo = null;
  editing = msg;
  showContext('Editing your message', preview(msg));
  $('input').value = msg.text || '';
  $('input').focus();
  $('input').setSelectionRange($('input').value.length, $('input').value.length);
}

$('contextCancel').onclick = () => {
  const wasEditing = !!editing;
  clearContext();
  if (!wasEditing) $('input').focus();
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('contextBar').hidden) $('contextCancel').click();
});

/** Consume any pending reply, so photos and voice mails can answer too. */
function takeReply() {
  const id = replyTo?.id ?? null;
  if (replyTo) clearContext();
  return id;
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
  if (msg.videoPath) sb.storage.from('videos').remove([msg.videoPath]);
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
  setTyping(false);

  // Saving a correction rather than sending something new.
  if (editing) {
    const target = editing;
    if (text === target.text) return clearContext();
    clearContext();
    const { error } = await sb.from('messages').update({ body: text }).eq('id', target.id);
    if (error) toast('Could not save the edit');
    return;
  }

  const parent = replyTo;
  $('input').value = '';
  clearContext();

  const { error } = await sb.from('messages').insert({
    sender: myId,
    sender_name: myName,
    kind: 'text',
    body: text,
    reply_to: parent?.id ?? null,
  });

  if (error) {
    $('input').value = text;
    if (parent) startReply(parent);
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
    reply_to: takeReply(),
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
  // Behind the lock screen you haven't actually seen anything yet.
  if (!$('lock').hidden) return;
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
