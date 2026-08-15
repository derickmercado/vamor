/**
 * Vamor — push notifier.
 *
 * The sender's browser calls this straight after a message lands. It works
 * out who the *other* member is and pushes to their registered devices.
 *
 * Deliberately carries no payload: the notification text is a fixed string
 * baked into the service worker, so nothing about the conversation is ever
 * handed to Apple's or Google's push servers.
 *
 * Secrets it needs (Edge Functions → Secrets):
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
 */

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:vamor@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // Who is calling? The caller's JWT rides along on the invoke.
  const auth = req.headers.get('Authorization') ?? '';
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: userData, error: userErr } = await admin.auth.getUser(auth.replace('Bearer ', ''));
  const email = userData?.user?.email?.toLowerCase();
  if (userErr || !email) return json({ error: 'unauthorized' }, 401);

  // ...and are they actually one of the two of us?
  const { data: me } = await admin.from('members').select('email').eq('email', email).maybeSingle();
  if (!me) return json({ error: 'not a member' }, 403);

  // Everyone who isn't the sender.
  const { data: others } = await admin.from('members').select('email').neq('email', email);
  const recipients = (others ?? []).map((m) => m.email);
  if (!recipients.length) return json({ sent: 0 });

  const { data: subs } = await admin.from('push_subs').select('*').in('email', recipients);
  if (!subs?.length) return json({ sent: 0 });

  let sent = 0;
  const dead: string[] = [];

  await Promise.all(
    subs.map(async (row) => {
      try {
        await webpush.sendNotification(row.sub, null);
        sent++;
      } catch (err) {
        // 404/410 mean the browser threw the subscription away — forget it,
        // otherwise we retry a dead endpoint on every single message.
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.push(row.endpoint);
        else console.error('push failed', code, String(err));
      }
    })
  );

  if (dead.length) await admin.from('push_subs').delete().in('endpoint', dead);

  return json({ sent, pruned: dead.length });
});
