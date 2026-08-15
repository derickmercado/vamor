# 💌 Vamor

A tiny private messenger for two people. Text each other, or hold the mic and
leave a voice mail — she can listen and reply the same way.

Static front end on Vercel, Supabase for data, storage and realtime. No
backend to run, no build step, one dependency loaded straight from a CDN.

## How it works

There is no server of ours in the middle. The browser talks to Supabase
directly:

| Concern | Handled by |
| --- | --- |
| Messages | Postgres table `messages` |
| Voice clips | Supabase Storage, private `voice` bucket |
| Instant delivery | Supabase Realtime (WebSocket) |
| Online + typing | Realtime Presence |
| Who's allowed in | Supabase Auth + RLS against the `members` table |

Vercel only serves five static files. That's why there are no cold starts and
no function bills.

## Security

The anon key in [`public/config.js`](public/config.js) is *meant* to be public —
it identifies the project, it doesn't grant access. What actually protects the
conversation is Row Level Security: every policy in
[`supabase/schema.sql`](supabase/schema.sql) is gated behind `is_member()`,
which checks the signed-in email against the `members` table.

Verified against the live project with the anon key alone:

- reading `messages` returns `[]`
- inserting a message returns `401`
- listing the `voice` bucket returns `[]`

Voice clips are in a **private** bucket and play through signed URLs that
expire after an hour, so audio is never reachable by URL alone.

Never put the `service_role` key in `config.js`. It bypasses RLS entirely.

## Setup

**1. Supabase project** — create one at [supabase.com](https://supabase.com).

**2. Schema** — edit the two emails at the top of
[`supabase/schema.sql`](supabase/schema.sql), then paste the whole file into
the SQL Editor and run it. Those two emails are the entire allowlist.

**3. Keys** — Project Settings → API. Put the **Project URL** and **anon
public** key into [`public/config.js`](public/config.js).

**4. Custom SMTP — not optional.** Supabase's built-in email service refuses
to deliver to any address that isn't on your project's team ("Email address
not authorized") and allows only ~2 emails/hour. Without SMTP, *she never
receives a sign-in email.*

With no domain of your own, Gmail is the easy route. Turn on 2-Step
Verification, create an **App password**, then fill in Authentication →
Emails → **SMTP Settings**:

| Field | Value |
| --- | --- |
| Host | `smtp.gmail.com` |
| Port | `465` |
| Username / Sender | your Gmail address |
| Password | the 16-character app password |

**5. Email code** — SMTP also unlocks template editing. Authentication →
Emails → Templates → **Magic link or OTP**, and add:

```html
<p>Or enter this code: {{ .Token }}</p>
```

Magic links often open in the wrong browser on a phone, which loses the
session. The 6-digit code is the fallback that reliably works on mobile.

**6. Deploy** — import the repo at [vercel.com/new](https://vercel.com/new).
Framework preset **Other**; [`vercel.json`](vercel.json) handles the rest.

**7. Redirect allowlist** — back in Supabase, Authentication → URL
Configuration. Set **Site URL** to your Vercel URL and add it under **Redirect
URLs**. Sign-in silently fails without this, so don't skip it.

## Local preview

```bash
node dev-server.js     # http://localhost:3000
```

Serves `public/` against the same Supabase project. Nothing else to install.

## What's in it

- **Voice mails** — hold 🎙 to record, release to send. Tap it quickly instead
  and recording locks on hands-free; tap again to send, `✕` to discard.
  Bubbles show the clip's real waveform, computed from the audio at record
  time; tap the waveform to scrub.
- **Live typing indicator**, online status, and *Active 5m ago*.
- **Seen** receipts.
- **Reactions** — long-press (or right-click) any bubble.
- **Unsend** — long-press your own message and hit 🗑. Removes the audio file
  from storage too.
- Day separators, message grouping, a soft chime on arrival, desktop
  notifications when the tab is backgrounded, dark/light theme.
- Mobile-first: tracks the on-screen keyboard via `visualViewport`, respects
  safe-area insets, and installs to the home screen as a standalone app.

## Layout

```
public/index.html   markup
public/config.js    your Supabase URL + anon key
public/app.js       auth, realtime, recording, playback, UI
public/style.css    theme, bubbles, composer, responsive rules
supabase/schema.sql tables, RLS policies, storage bucket
vercel.json         static hosting + security headers
dev-server.js       local preview only
```

## Notes

- **Microphone requires HTTPS.** Vercel gives you that; `localhost` is also
  exempt. It will not work over a plain LAN IP.
- Supabase pauses free projects after about a week of inactivity. If you both
  go quiet for a while, unpause it from the dashboard.
