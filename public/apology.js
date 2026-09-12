/**
 * A one-time apology for Amor.
 *
 * Shows the first time she opens the app after this deploy, then never again.
 * "Seen" is kept on her own Supabase account (user metadata) rather than on
 * the device, so a second phone or a cleared browser won't bring it back, and
 * no table needed changing for it.
 *
 * It lives in its own file so it can be deleted whole once it has done its
 * job: remove this file and the apologize() call in app.js.
 *
 * Preview it on any account by adding ?apology to the URL. A preview records
 * nothing and sends nothing.
 */

// Change this to run a new apology some other day. Anyone who saw an older
// one sees the new one once.
const ID = 'sorry-again-1';

const WORDS = ['Hi babe,', "I'm sorry again."];
const REPLY = 'I forgive you 💖';

/* Shown to everyone except him, rather than to her by address. If the
   addresses in the database ever drift from what's written here, he sees it
   on his own phone — loud and harmless, since "seen" is per account — instead
   of her silently never seeing it. His address is kept as a hash so it never
   ships in a public file; the name covers a changed sign-in address. */
const HIS_EMAIL_SHA256 = 'f6cdff8dfdc2c3e70b6198efe41626fdf23da0e09c0486cbece3b79c7b057624';
const HIS_NAME = /^myles$/i;

// What "No" says each time it gets away, and the face that goes with it.
const DODGES = [
  ['Are you sure?', '🥺'],
  ['Really sure?', '😢'],
  ['Think again 🥺', '🥺'],
  ['Pretty please?', '🥹'],
  ["I'll cry 😭", '😭'],
  ["You're breaking my heart", '💔'],
  ["Okay I'm sad now", '😢'],
  ['Last chance!', '😭'],
];

const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export async function maybeApologize(ctx) {
  const preview = new URLSearchParams(location.search).has('apology');
  if (!preview) {
    if (HIS_NAME.test(ctx.name || '')) return;
    if ((await sha256(ctx.email || '')) === HIS_EMAIL_SHA256) return;
    if (await alreadySeen(ctx.sb)) return;
  }
  play({ ...ctx, preview });
}

async function alreadySeen(sb) {
  // The session copy is instant but can be up to an hour stale on a second
  // device, so only a "not yet" is worth confirming with the server.
  const { data } = await sb.auth.getSession();
  if (data.session?.user?.user_metadata?.apology_seen === ID) return true;
  const { data: fresh, error } = await sb.auth.getUser();
  if (error) return false; // offline: showing it twice beats never showing it
  return fresh.user?.user_metadata?.apology_seen === ID;
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text.trim().toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------- the scene */

function play({ sb, mount, send, toast, preview }) {
  injectStyle();
  document.activeElement?.blur(); // keep the phone keyboard from covering it

  // Mounted inside the chat screen, so re-locking hides it along with the
  // conversation and unlocking brings it back exactly where she left off.
  const root = document.createElement('div');
  root.className = 'apology';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', WORDS.join(' '));
  root.innerHTML = `
    <div class="ap-sky" aria-hidden="true"></div>
    <button class="ap-x" type="button" aria-label="Close">✕</button>
    <div class="ap-card">
      <div class="ap-face" aria-hidden="true">🥺</div>
      <div class="ap-poke" aria-hidden="true"><span>👉</span><span>👈</span></div>
      <h2 class="ap-words"><span class="ap-l1"></span><span class="ap-l2"></span></h2>
      <p class="ap-ask" hidden>Forgive me?</p>
      <div class="ap-choices" hidden>
        <button class="ap-yes" type="button">Yes 💖</button>
        <button class="ap-no" type="button">No</button>
      </div>
      <div class="ap-end" hidden>
        <button class="ap-send" type="button">Message me 💌</button>
        <button class="ap-close" type="button">Close</button>
      </div>
    </div>`;
  mount.append(root);

  const q = (sel) => root.querySelector(sel);
  const face = q('.ap-face');
  const l1 = q('.ap-l1');
  const l2 = q('.ap-l2');
  const ask = q('.ap-ask');
  const yes = q('.ap-yes');
  const no = q('.ap-no');
  const sendBtn = q('.ap-send');

  fillSky(q('.ap-sky'));

  let recorded = false;
  const markSeen = () => {
    if (recorded || preview) return;
    recorded = true;
    sb.auth
      .updateUser({ data: { apology_seen: ID } })
      .then(({ error }) => error && (recorded = false)) // let a later step retry
      .catch(() => (recorded = false));
  };

  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);

  function close() {
    markSeen();
    document.removeEventListener('keydown', onKey);
    root.classList.add('ap-out');
    setTimeout(() => root.remove(), calm ? 0 : 400);
  }

  q('.ap-x').onclick = close;
  q('.ap-close').onclick = close;

  /* "No" can't be caught. Touch has no hover, so the tap itself is what it
     runs from; a mouse gets the classic version and never reaches it. */
  let tries = 0;

  function dodge(e) {
    e?.preventDefault();

    // Lift it out of the card the first time, from exactly where it sits,
    // so the first jump animates instead of teleporting.
    if (!no.classList.contains('ap-loose')) {
      const r = no.getBoundingClientRect();
      no.style.left = `${r.left}px`;
      no.style.top = `${r.top}px`;
      no.classList.add('ap-loose');
      root.append(no);
      void no.offsetWidth;
    }

    // After "Last chance!" it starts begging all over again, for as long as
    // she keeps trying. Yes stops growing once it's big enough.
    const [line, mood] = DODGES[tries % DODGES.length];
    tries++;
    no.textContent = line;
    face.textContent = mood;
    yes.style.fontSize = `${Math.min(17 + tries * 3, 40)}px`;
    navigator.vibrate?.(12);

    const [x, y] = somewhereElse(no, yes, e);
    no.style.left = `${x}px`;
    no.style.top = `${y}px`;
  }

  no.addEventListener('pointerdown', dodge);
  no.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && dodge(e));
  no.addEventListener('click', (e) => {
    e.preventDefault();
    if (e.detail === 0) dodge(); // keyboard; a real tap was handled on pointerdown
  });

  yes.onclick = () => {
    markSeen();
    const r = yes.getBoundingClientRect();
    no.remove();
    q('.ap-choices').hidden = true;
    ask.hidden = true;
    q('.ap-poke').hidden = true;
    face.textContent = '🥰';
    face.classList.add('ap-happy');
    l1.textContent = 'Yaaay!! 💖';
    l2.textContent = 'Thank you, babe.';
    root.classList.add('ap-party');
    burst(root, r.left + r.width / 2, r.top + r.height / 2);
    chime();
    navigator.vibrate?.([30, 50, 30, 50, 80]);
    setTimeout(() => (q('.ap-end').hidden = false), calm ? 0 : 900);
  };

  sendBtn.onclick = async () => {
    if (preview) {
      toast('Preview — nothing was sent');
      return close();
    }
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    if (await send(REPLY)) {
      sendBtn.textContent = 'Sent 💌';
      setTimeout(close, 900);
    } else {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Try again 💌';
    }
  };

  (async () => {
    await wait(calm ? 0 : 700); // let the card land first
    await type(l1, WORDS[0]);
    await wait(calm ? 0 : 450);
    await type(l2, WORDS[1]);
    markSeen(); // the words have been on her screen now
    await wait(calm ? 0 : 650);
    ask.hidden = false;
    q('.ap-choices').hidden = false;
  })();
}

async function type(el, text) {
  el.classList.add('ap-typing');
  for (const ch of text) {
    el.textContent += ch;
    if (!calm) await wait(ch === ',' || ch === '.' ? 260 : 55 + Math.random() * 45);
  }
  el.classList.remove('ap-typing');
}

/** A random spot on screen that isn't on the Yes button or under her finger. */
function somewhereElse(el, avoid, e) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const a = avoid.getBoundingClientRect();
  const pad = 14;
  const top = 56; // clear of the close button and the status bar
  let x = pad;
  let y = top;
  for (let i = 0; i < 30; i++) {
    x = pad + Math.random() * Math.max(0, innerWidth - w - pad * 2);
    y = top + Math.random() * Math.max(0, innerHeight - h - pad - top);
    const onYes = x < a.right + pad && x + w > a.left - pad && y < a.bottom + pad && y + h > a.top - pad;
    const underFinger =
      e?.clientX != null && Math.hypot(x + w / 2 - e.clientX, y + h / 2 - e.clientY) < 120;
    if (!onYes && !underFinger) break;
  }
  return [x, y];
}

/** Hearts drifting up behind the card. */
function fillSky(sky) {
  if (calm) return;
  for (let i = 0; i < 16; i++) {
    const h = document.createElement('span');
    h.textContent = pick(['💗', '💕', '💖', '💞', '🤍']);
    h.style.left = `${Math.random() * 100}%`;
    h.style.fontSize = `${14 + Math.random() * 20}px`;
    h.style.animationDuration = `${7 + Math.random() * 6}s`;
    h.style.animationDelay = `${-Math.random() * 12}s`; // start mid-flight
    h.style.setProperty('--sway', `${(Math.random() - 0.5) * 80}px`);
    sky.append(h);
  }
}

/** Hearts thrown out from where she tapped Yes. */
function burst(root, x, y) {
  if (calm) return;
  for (let i = 0; i < 38; i++) {
    const b = document.createElement('span');
    b.className = 'ap-bit';
    b.textContent = pick(['💖', '💕', '💗', '✨', '💘', '🌸']);
    const angle = Math.random() * Math.PI * 2;
    const dist = 90 + Math.random() * 190;
    b.style.left = `${x}px`;
    b.style.top = `${y}px`;
    b.style.fontSize = `${16 + Math.random() * 18}px`;
    b.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    b.style.setProperty('--dy', `${Math.sin(angle) * dist + 60}px`); // a little gravity
    b.style.setProperty('--r', `${(Math.random() - 0.5) * 540}deg`);
    b.style.animationDelay = `${Math.random() * 120}ms`;
    b.addEventListener('animationend', () => b.remove());
    root.append(b);
  }
}

/** A rising four-note arpeggio. Yes is a tap, so audio is allowed to start. */
function chime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const t = ac.currentTime + i * 0.09;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      osc.connect(gain).connect(ac.destination);
      osc.start(t);
      osc.stop(t + 0.45);
    });
    setTimeout(() => ac.close(), 1500);
  } catch {
    /* no audio is fine */
  }
}

/* ----------------------------------------------------------------- style */

function injectStyle() {
  if (document.getElementById('apology-style')) return;
  const s = document.createElement('style');
  s.id = 'apology-style';
  s.textContent = CSS;
  document.head.append(s);
}

const CSS = `
.apology [hidden] { display: none !important; }

.apology {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 16px;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 35%, rgba(255, 93, 143, 0.38), transparent 62%),
    rgba(14, 10, 28, 0.58);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  touch-action: manipulation;
  -webkit-user-select: none;
  user-select: none;
  animation: ap-fade-in 0.45s ease both;
}
.apology.ap-out { animation: ap-fade-out 0.4s ease both; }
@keyframes ap-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes ap-fade-out { from { opacity: 1; } to { opacity: 0; } }

.ap-sky { position: absolute; inset: 0; pointer-events: none; }
.ap-sky span {
  position: absolute;
  bottom: -40px;
  opacity: 0.55;
  animation: ap-rise linear infinite;
  transition: opacity 0.6s;
}
.ap-party .ap-sky span { opacity: 0.95; }
@keyframes ap-rise {
  from { transform: translate(0, 0) rotate(-8deg); }
  50% { transform: translate(var(--sway), -55vh) rotate(8deg); }
  to { transform: translate(0, -115vh) rotate(-8deg); }
}

.ap-x {
  position: absolute;
  top: max(12px, env(safe-area-inset-top));
  right: 12px;
  z-index: 2;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.7);
  font-size: 14px;
}
.ap-x:hover { background: rgba(255, 255, 255, 0.2); color: #fff; }

.ap-card {
  position: relative;
  width: min(360px, 100%);
  padding: 26px 22px 24px;
  border-radius: 28px;
  background: var(--panel);
  color: var(--text);
  text-align: center;
  box-shadow: 0 30px 80px rgba(255, 93, 143, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.06);
  animation: ap-in 0.75s cubic-bezier(0.2, 1.35, 0.4, 1) both;
}
@keyframes ap-in {
  from { opacity: 0; transform: translateY(40px) scale(0.7) rotate(-4deg); }
  to { opacity: 1; transform: none; }
}

.ap-face {
  display: inline-block;
  font-size: 68px;
  line-height: 1;
  animation: ap-bob 2.6s ease-in-out infinite;
}
@keyframes ap-bob {
  0%, 100% { transform: translateY(0) rotate(-4deg); }
  50% { transform: translateY(-8px) rotate(4deg); }
}
.ap-face.ap-happy {
  animation:
    ap-jump 0.6s cubic-bezier(0.3, 1.6, 0.5, 1) 3,
    ap-bob 2.6s ease-in-out 1.8s infinite;
}
@keyframes ap-jump {
  0%, 100% { transform: translateY(0) scale(1); }
  40% { transform: translateY(-18px) scale(1.15); }
}

/* The shy finger-poke: each hand edges toward the other and back. */
.ap-poke { margin: 6px 0 2px; font-size: 22px; letter-spacing: 2px; }
.ap-poke span { display: inline-block; }
.ap-poke span:first-child { animation: ap-poke-l 1.1s ease-in-out infinite; }
.ap-poke span:last-child { animation: ap-poke-r 1.1s ease-in-out infinite; }
@keyframes ap-poke-l { 0%, 100% { transform: translateX(-3px); } 50% { transform: translateX(4px); } }
@keyframes ap-poke-r { 0%, 100% { transform: translateX(3px); } 50% { transform: translateX(-4px); } }

.ap-words {
  margin: 14px 0 0;
  font-size: 26px;
  font-weight: 760;
  line-height: 1.25;
  letter-spacing: -0.01em;
}
/* Both lines hold their height from the start, so the card doesn't grow
   under her while the words type out. */
.ap-l1, .ap-l2 { display: block; min-height: 1.25em; }
.ap-l2 {
  width: fit-content;
  margin-inline: auto;
  background: linear-gradient(100deg, var(--me-1), var(--me-2));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.ap-typing::after {
  content: '';
  display: inline-block;
  width: 2px;
  height: 0.95em;
  margin-left: 3px;
  vertical-align: -0.1em;
  background: var(--me-1);
  animation: ap-caret 0.8s steps(1) infinite;
}
@keyframes ap-caret { 50% { opacity: 0; } }

.ap-ask { margin: 14px 0 0; color: var(--muted); font-size: 15px; }

.ap-ask:not([hidden]),
.ap-choices:not([hidden]),
.ap-end:not([hidden]) { animation: ap-up 0.45s ease both; }
@keyframes ap-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}

.ap-choices,
.ap-end {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}
.ap-choices { min-height: 52px; }

.ap-yes, .ap-no, .ap-send, .ap-close {
  max-width: 100%;
  padding: 0.7em 1.5em;
  border-radius: 999px;
  font-size: 17px;
  font-weight: 700;
  line-height: 1.1;
}
.ap-yes, .ap-send {
  color: #fff;
  background: linear-gradient(100deg, var(--me-1), var(--me-2));
  transition: font-size 0.28s cubic-bezier(0.3, 1.5, 0.5, 1);
  animation: ap-glow 1.8s ease-in-out infinite;
}
@keyframes ap-glow {
  0%, 100% { box-shadow: 0 8px 22px rgba(255, 93, 143, 0.4); }
  50% { box-shadow: 0 8px 32px rgba(255, 93, 143, 0.75); }
}
.ap-send:disabled { opacity: 0.7; }
.ap-no, .ap-close {
  color: var(--muted);
  background: var(--panel-2);
  border: 1px solid var(--line);
}

.ap-no.ap-loose {
  position: fixed;
  z-index: 3;
  margin: 0;
  font-size: 15px;
  white-space: nowrap;
  box-shadow: var(--shadow);
  transition:
    left 0.28s cubic-bezier(0.3, 1.3, 0.5, 1),
    top 0.28s cubic-bezier(0.3, 1.3, 0.5, 1);
}

.ap-bit {
  position: fixed;
  z-index: 4;
  pointer-events: none;
  animation: ap-burst 1.3s cubic-bezier(0.15, 0.8, 0.3, 1) both;
}
@keyframes ap-burst {
  from { transform: translate(-50%, -50%) scale(0.2); opacity: 1; }
  75% { opacity: 1; }
  to {
    transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) rotate(var(--r)) scale(1);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .apology, .apology * { animation: none !important; transition: none !important; }
}
`;
