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
  SUPABASE_URL: 'https://vyxwgavernclkzauntlk.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5eHdnYXZlcm5jbGt6YXVudGxrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3OTg4NjMsImV4cCI6MjEwMjM3NDg2M30.ii5k3TIjQpTXkm7HIdEkbGwzzd6fhghlcDG_g4mhJsY',
};
