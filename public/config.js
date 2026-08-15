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

  SUPABASE_URL: 'https://vyxwgavernclkzauntlk.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5eHdnYXZlcm5jbGt6YXVudGxrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3OTg4NjMsImV4cCI6MjEwMjM3NDg2M30.ii5k3TIjQpTXkm7HIdEkbGwzzd6fhghlcDG_g4mhJsY',
};
