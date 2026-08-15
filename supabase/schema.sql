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
  kind        text not null check (kind in ('text', 'voice')),
  body        text,
  audio_path  text,
  duration    real,
  peaks       real[],
  reaction    text,
  deleted     boolean not null default false,
  created_at  timestamptz not null default now(),

  -- A row is either words or a voice clip, never neither.
  constraint has_content check (
    (kind = 'text'  and body is not null) or
    (kind = 'voice' and audio_path is not null)
  )
);

create index if not exists messages_created_idx on public.messages (id);

-- ------------------------------------------------------------------- RLS

alter table public.members  enable row level security;
alter table public.messages enable row level security;

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
