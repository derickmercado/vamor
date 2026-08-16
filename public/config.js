/**
 * Vamor configuration.
 *
 * Both values below come from your Supabase dashboard:
 *   Project Settings -> API -> "Project URL" and "anon public" key.
 *
 * The anon key is meant to live in the browser — it is not a secret. What
 * actually protects the conversation is the Row Level Security policies in
 * supabase/schema.sql, which only let the two emails in the `members` table
 * read or write anything.
 *
 * Never put the `service_role` key here. That one bypasses RLS entirely.
 */
window.VAMOR_CONFIG = {
  /**
   * SHA-256 of the shared passphrase that locks the conversation once you're
   * signed in. This is a screen lock, not a security boundary: it stops
   * someone holding your unlocked phone, but anyone reading this file could
   * bypass the check. Sign-in is what actually keeps strangers out.
   *
   * To change it:  node -e "console.log(require('crypto').createHash('sha256').update('NEW ONE').digest('hex'))"
   * To remove it:  set this to '' (empty string).
   */
  PASSPHRASE_SHA256: 'fc0eb3f2ef3bce789df7e5a09438023e4ae0198cfc8f2f8461f31bd0261214b6',

  /**
   * Re-lock when the app is hidden — another tab, another app, screen off,
   * or the browser closed. Set to false to stay unlocked until the tab closes.
   */
  LOCK_ON_HIDE: true,

  /**
   * Seconds of being hidden before it actually re-locks. 0 locks the instant
   * you look away. A few seconds is friendlier if you flick between tabs a
   * lot, and still locks whenever you genuinely leave.
   */
  LOCK_GRACE_SECONDS: 0,

  /**
   * Also re-lock after this many seconds of no typing, tapping or scrolling,
   * even with the app open in front of you. 0 turns idle locking off.
   * Recording and media playback hold it off, so a long voice note or video
   * won't lock mid-way.
   */
  IDLE_LOCK_SECONDS: 60,

  /**
   * What a notification says. It's the same every time and carries no payload,
   * so nothing about the conversation reaches Apple's or Google's servers —
   * and a glance at the lock screen gives nothing away either.
   *
   * Note the browser always adds its own "from <site>" line underneath, taken
   * from the domain. No page can change or hide that.
   */
  NOTIFY_TITLE: 'VALORANT',
  NOTIFY_BODY: 'valorant update 6.33.7',

  /**
   * Public half of the VAPID keypair, for push notifications. Safe to ship —
   * it only identifies the sender. The private half lives in the Supabase
   * Edge Function's secrets and must never appear here.
   * Empty disables push entirely.
   */
  VAPID_PUBLIC_KEY: 'BLgiomYUR_DfwkAH1fqc5DM-tmMpiJhYnHFDgegkYwS-uiQ9JVlMnFGd0fgFWxpG9AWBIXzcCUe4kHyneZ4hT-4',

  /**
   * Giphy API key, for the GIF search button. Free: sign in at
   * developers.giphy.com, "Create an App", pick the API option, copy the key.
   * Leave it empty and the GIF button simply doesn't appear — you can still
   * send .gif files with the picture button.
   */
  GIPHY_API_KEY: 'g2wRTf09H9PvPkJBUMKQo092amepEBWG',

  SUPABASE_URL: 'https://vyxwgavernclkzauntlk.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5eHdnYXZlcm5jbGt6YXVudGxrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3OTg4NjMsImV4cCI6MjEwMjM3NDg2M30.ii5k3TIjQpTXkm7HIdEkbGwzzd6fhghlcDG_g4mhJsY',
};
