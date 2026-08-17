-- ============================================================================
--  Vamor — Supabase schema
--  Paste this whole file into the Supabase SQL Editor and hit Run.
--  Safe to re-run: everything is idempotent.
-- ============================================================================

-- ---------------------------------------------------------------- members
-- The allowlist. Only emails in this table can read or write anything.
-- Seed it with the two of you BEFORE either of you signs in.

create table if not exists public.members (
  email        text primary key,
  display_name text not null,
  avatar       text not null default '💖',
  last_read    bigint not null default 0,
  updated_at   timestamptz not null default now()
);

-- >>> EDIT THESE TWO LINES <<<
insert into public.members (email, display_name, avatar) values
  ('derick.mercado2124@gmail.com', 'Myles', '💙'),
  ('justeniabatula10@gmail.com', 'Amor',   '💖')
on conflict (email) do nothing;

-- Profile pictures were added later; the emoji in `avatar` stays as the
-- fallback until someone uploads one.
alter table public.members add column if not exists avatar_url text;

-- Is the current caller one of the two of us?
create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.members
    where email = nullif(auth.jwt() ->> 'email', '')
  );
$$;

-- --------------------------------------------------------------- messages

create table if not exists public.messages (
  id          bigint generated always as identity primary key,
  sender      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  sender_name text not null,
  kind        text not null,
  body        text,
  audio_path  text,
  duration    real,
  peaks       real[],
  image_path  text,
  width       int,
  height      int,
  reaction    text,
  deleted     boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists messages_created_idx on public.messages (id);

-- Photo support was added after the first version, so bring older projects
-- forward. These are no-ops on a fresh install.
alter table public.messages add column if not exists image_path text;
alter table public.messages add column if not exists width  int;
alter table public.messages add column if not exists height int;

-- Picker GIFs are hotlinked from Giphy rather than copied into storage, so
-- they carry a URL instead of a bucket path.
alter table public.messages add column if not exists remote_url text;

-- Replies point at another message; edits are stamped by a trigger below.
alter table public.messages add column if not exists reply_to  bigint
  references public.messages(id) on delete set null;
alter table public.messages add column if not exists edited_at timestamptz;

-- Videos are stored untouched for quality; image_path doubles as the poster
-- frame so galleries and bubbles can show a still without fetching the file.
alter table public.messages add column if not exists video_path text;

alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add  constraint messages_kind_check
  check (kind in ('text', 'voice', 'photo', 'gif', 'video'));

-- A row always carries exactly the payload its kind promises.
alter table public.messages drop constraint if exists has_content;
alter table public.messages add  constraint has_content check (
  (kind = 'text'  and body       is not null) or
  (kind = 'voice' and audio_path is not null) or
  (kind = 'photo' and image_path is not null) or
  (kind = 'gif'   and remote_url is not null) or
  (kind = 'video' and video_path is not null)
);

-- ------------------------------------------------------------------- room
-- One shared row holding the look of the conversation, so a theme either of
-- you picks shows up for both.

create table if not exists public.room (
  id         int primary key default 1 check (id = 1),
  theme      text not null default 'default',
  bg_path    text,
  updated_at timestamptz not null default now()
);

insert into public.room (id) values (1) on conflict (id) do nothing;

-- How strongly the background picture is dimmed, so bubbles stay readable.
alter table public.room add column if not exists bg_dim real not null default 0.45;

-- One message can be held at the top of the thread — the thing worth keeping
-- in sight. It lives on the room rather than the message so there is only
-- ever one, and so both of you see the same one. Unsending it clears it.
alter table public.room add column if not exists pinned_id bigint
  references public.messages(id) on delete set null;

-- ------------------------------------------------------------ push subs
-- One row per browser that agreed to notifications. The Edge Function reads
-- these with the service role; neither of you can read the other's.

create table if not exists public.push_subs (
  endpoint   text primary key,
  email      text not null,
  sub        jsonb not null,
  created_at timestamptz not null default now()
);

-- --------------------------------------------------------------- guardrail
-- Reactions require letting each of you update the other's messages, but that
-- must not extend to rewriting what the other person said. Anything except
-- the reaction is silently reverted on someone else's row, and an edit to
-- your own text is stamped here rather than trusted from the client.

create or replace function public.guard_message_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.sender is distinct from auth.uid() then
    new.sender      := old.sender;
    new.sender_name := old.sender_name;
    new.kind        := old.kind;
    new.body        := old.body;
    new.audio_path  := old.audio_path;
    new.image_path  := old.image_path;
    new.remote_url  := old.remote_url;
    new.duration    := old.duration;
    new.peaks       := old.peaks;
    new.width       := old.width;
    new.height      := old.height;
    new.reply_to    := old.reply_to;
    new.deleted     := old.deleted;
    new.edited_at   := old.edited_at;
    new.created_at  := old.created_at;
  elsif new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists guard_message_update on public.messages;
create trigger guard_message_update
  before update on public.messages
  for each row execute function public.guard_message_update();

-- ------------------------------------------------------------------- RLS

alter table public.members   enable row level security;
alter table public.messages  enable row level security;
alter table public.room      enable row level security;
alter table public.push_subs enable row level security;

drop policy if exists "own push subs"    on public.push_subs;
drop policy if exists "add push sub"     on public.push_subs;
drop policy if exists "drop own push sub" on public.push_subs;

-- Your own devices only. The sender never sees where the other person's
-- notifications go.
create policy "own push subs"
  on public.push_subs for select
  using (email = auth.jwt() ->> 'email');

create policy "add push sub"
  on public.push_subs for insert
  with check (email = auth.jwt() ->> 'email');

create policy "drop own push sub"
  on public.push_subs for delete
  using (email = auth.jwt() ->> 'email');

drop policy if exists "members read room"   on public.room;
drop policy if exists "members update room" on public.room;

create policy "members read room"
  on public.room for select
  using (public.is_member());

create policy "members update room"
  on public.room for update
  using (public.is_member())
  with check (public.is_member());

drop policy if exists "members read members"   on public.members;
drop policy if exists "members update self"    on public.members;
drop policy if exists "members read messages"  on public.messages;
drop policy if exists "members write messages" on public.messages;
drop policy if exists "members edit messages"  on public.messages;

-- Both of you can see both member rows (needed to render her name and
-- her "Seen" position).
create policy "members read members"
  on public.members for select
  using (public.is_member());

-- You may only move your own read marker.
create policy "members update self"
  on public.members for update
  using (email = auth.jwt() ->> 'email')
  with check (email = auth.jwt() ->> 'email');

create policy "members read messages"
  on public.messages for select
  using (public.is_member());

-- You can only post as yourself.
create policy "members write messages"
  on public.messages for insert
  with check (public.is_member() and sender = auth.uid());

-- Either of you can react to anything, but only the author can unsend.
create policy "members edit messages"
  on public.messages for update
  using (public.is_member())
  with check (
    public.is_member()
    and (deleted = false or sender = auth.uid())
  );

-- -------------------------------------------------------------- realtime

alter table public.messages replica identity full;
alter table public.members  replica identity full;
alter table public.room     replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.members;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.room;
exception when duplicate_object then null;
end $$;

-- --------------------------------------------------------------- storage
-- Private bucket for the voice clips. Playback goes through short-lived
-- signed URLs, so the audio is never publicly reachable.

insert into storage.buckets (id, name, public)
values ('voice', 'voice', false)
on conflict (id) do nothing;

drop policy if exists "members read voice"   on storage.objects;
drop policy if exists "members upload voice" on storage.objects;
drop policy if exists "members delete voice" on storage.objects;

create policy "members read voice"
  on storage.objects for select
  using (bucket_id = 'voice' and public.is_member());

create policy "members upload voice"
  on storage.objects for insert
  with check (bucket_id = 'voice' and public.is_member());

create policy "members delete voice"
  on storage.objects for delete
  using (bucket_id = 'voice' and owner = auth.uid());

-- Same deal for photos: private bucket, signed URLs only.

insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "members read photos"   on storage.objects;
drop policy if exists "members upload photos" on storage.objects;
drop policy if exists "members delete photos" on storage.objects;

create policy "members read photos"
  on storage.objects for select
  using (bucket_id = 'photos' and public.is_member());

create policy "members upload photos"
  on storage.objects for insert
  with check (bucket_id = 'photos' and public.is_member());

create policy "members delete photos"
  on storage.objects for delete
  using (bucket_id = 'photos' and owner = auth.uid());

-- Videos, uploaded as-is so quality is untouched. 50MB is the ceiling the
-- free plan allows per file; raise file_size_limit if you upgrade.

insert into storage.buckets (id, name, public, file_size_limit)
values ('videos', 'videos', false, 52428800)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

drop policy if exists "members read videos"   on storage.objects;
drop policy if exists "members upload videos" on storage.objects;
drop policy if exists "members delete videos" on storage.objects;

create policy "members read videos"
  on storage.objects for select
  using (bucket_id = 'videos' and public.is_member());

create policy "members upload videos"
  on storage.objects for insert
  with check (bucket_id = 'videos' and public.is_member());

create policy "members delete videos"
  on storage.objects for delete
  using (bucket_id = 'videos' and owner = auth.uid());
