# 💌 Vamor

A tiny private messenger for two people. Text each other, or hold the mic and
leave a voice mail — she can listen and reply the same way.

No accounts, no login, no database, **no dependencies**. Just Node.

## Run it

```bash
node server.js
```

Then open <http://localhost:3000>. The console also prints a `network:` address —
open that one on her phone (same Wi‑Fi) and you're chatting.

Set your names:

```bash
NAMES="Derick,Bebe" PORT=3000 node server.js
```

First visit asks *"Who's this?"* — tap a name once and it's remembered on that
device. The `⇄` button in the header switches.

## What's in it

- **Voice mails** — hold 🎙 to record, release to send. Tap it quickly instead
  and recording locks on (hands-free); tap again to send, `✕` to throw it away.
  Bubbles show the clip's real waveform; tap anywhere on it to scrub.
- **Live typing indicator**, online status and *Active 5m ago*.
- **Seen** receipts.
- **Reactions** — long-press (or right-click) any bubble.
- **Unsend** — long-press your own message and hit 🗑.
- Day separators, message grouping, a soft chime on arrival, desktop
  notifications when the tab is in the background, dark/light theme.

## How it works

`server.js` is a plain `http` server: it serves `public/` and exposes a small
JSON API. Clients hold a long-poll open on `/api/sync`, so messages land
instantly without WebSockets or a build step.

Everything lives in `data/` — `messages.json` plus one file per voice note in
`data/audio/`. Delete the folder to wipe the history. It's gitignored, so your
conversation never leaves your machine.

## Putting it online

The server is a normal Node app (`npm start`), so anything that runs Node works
— Render, Railway, Fly.io, a VPS. Two things to know first:

- **Microphone recording requires HTTPS** on any host other than `localhost`.
  Use a provider that terminates TLS for you, or run it over Tailscale.
- **There is no authentication.** Anyone who knows the URL can read the
  conversation and post to it. That's fine on your home Wi‑Fi; if you deploy it
  to the open internet, put it behind a login, a VPN, or at minimum an
  unguessable hostname.

## Layout

```
server.js          API + static files + storage
public/index.html  markup
public/style.css   theme, bubbles, composer
public/app.js      sync loop, recording, playback, UI
data/              conversation + audio (created on first run, gitignored)
```
