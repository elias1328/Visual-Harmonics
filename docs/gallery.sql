-- Visual Harmonics: community gallery.
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Stores only a title, a nickname and the song (the same text a share link carries). No emails, no IPs.

create table if not exists public.songs (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  title       text not null check (char_length(btrim(title)) between 1 and 60),
  author      text not null default 'Anonymous' check (char_length(btrim(author)) between 1 and 30),
  code        text not null check (char_length(code) between 10 and 60000),   -- the share-link song code
  meta        jsonb not null default '{}'::jsonb check (pg_column_size(meta) < 4000),  -- bpm, key, preview lines...
  likes       integer not null default 0,
  reports     integer not null default 0,
  hidden      boolean not null default false
);

create index if not exists songs_new_idx   on public.songs (created_at desc) where not hidden;
create index if not exists songs_liked_idx on public.songs (likes desc)      where not hidden;

alter table public.songs enable row level security;

-- Anyone may read songs that aren't hidden.
drop policy if exists "read visible songs" on public.songs;
create policy "read visible songs" on public.songs
  for select to anon, authenticated using (not hidden);

-- Anyone may post a new song, but only with fresh counters (no faking likes or un-hiding).
drop policy if exists "post new songs" on public.songs;
create policy "post new songs" on public.songs
  for insert to anon, authenticated
  with check (likes = 0 and reports = 0 and hidden = false);

-- No update/delete policies: visitors can't edit or delete. You can, from the dashboard (Table Editor).

-- Spam brake: at most 20 new songs per 10 minutes across the whole site.
create or replace function public.songs_rate_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.songs where created_at > now() - interval '10 minutes') >= 20 then
    raise exception 'The gallery is busy, please try again in a few minutes.';
  end if;
  new.title  := btrim(new.title);
  new.author := coalesce(nullif(btrim(new.author), ''), 'Anonymous');
  return new;
end $$;
drop trigger if exists songs_rate_limit on public.songs;
create trigger songs_rate_limit before insert on public.songs
  for each row execute function public.songs_rate_limit();

-- Likes and reports go through these functions, so visitors never get general update rights.
create or replace function public.like_song(song_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.songs set likes = likes + 1 where id = song_id and not hidden;
$$;

-- Three reports hide a song automatically; un-hide it in the Table Editor if it was fine.
create or replace function public.report_song(song_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.songs set reports = reports + 1, hidden = (reports + 1 >= 3) where id = song_id;
$$;

revoke all on function public.like_song(uuid), public.report_song(uuid) from public;
grant execute on function public.like_song(uuid), public.report_song(uuid) to anon, authenticated;


-- =====================================================================================================================
-- 2026-10 migration: short links + owner edit/delete
-- Run in the Supabase SQL editor (safe to run more than once). Until it has run, the app keeps working: Share gives the
-- long link, Publish sends no owner key, and the "My songs" edit / remove buttons stay hidden.
--   1. Short links: public.shares + create_share(data) -> 8-char id, get_share(id) -> data.
--   2. Owners: songs.owner_hash (SHA-256 of a secret that only the publishing browser knows) + delete_own_song /
--      update_own_song. Old rows have owner_hash null, so nobody can edit them.
-- Nobody can list the shares table: RLS is on and there is deliberately NO policy, and the functions below are the only way in.
-- =====================================================================================================================

-- ---- 1. short links ----
create table if not exists public.shares (
  id          text primary key check (id ~ '^[0-9A-Za-z]{8}$'),
  data        text not null check (char_length(data) between 10 and 60000 and data ~ '^[zj][A-Za-z0-9_-]+$'),   -- the share-link song code
  created_at  timestamptz not null default now()
);
create index if not exists shares_created_idx on public.shares (created_at);

alter table public.shares enable row level security;
-- No policies on purpose: anon / authenticated can neither select, insert, update nor delete. Only the functions below.
drop policy if exists "read shares" on public.shares;
revoke all on table public.shares from anon, authenticated;

-- Stores a share code and returns its short id. Size cap 60000 characters; at most 60 new links per 10 minutes site-wide.
create or replace function public.create_share(data text) returns text
language plpgsql security definer set search_path = public as $$
declare
  alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  pos constant int[] := array[0, 1, 2, 3, 4, 5, 9, 10];   -- uuid bytes without the version / variant ones
  b bytea; sid text; i int; tries int := 0;
begin
  if data is null or char_length(data) < 10 or char_length(data) > 60000 or data !~ '^[zj][A-Za-z0-9_-]+$' then
    raise exception 'That song is too long to share as a short link.';
  end if;
  if (select count(*) from public.shares where created_at > now() - interval '10 minutes') >= 60 then
    raise exception 'The gallery is busy, please try again in a few minutes.';
  end if;
  loop
    b := uuid_send(gen_random_uuid());
    sid := '';
    for i in 1..8 loop
      sid := sid || substr(alphabet, (get_byte(b, pos[i]) % 62) + 1, 1);
    end loop;
    begin
      insert into public.shares (id, data) values (sid, create_share.data);
      return sid;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 8 then raise exception 'Please try again.'; end if;
    end;
  end loop;
end $$;

-- Returns the code for one id (null when unknown). No listing, no search.
create or replace function public.get_share(id text) returns text
language sql stable security definer set search_path = public as $$
  select s.data from public.shares s where s.id = get_share.id and get_share.id ~ '^[0-9A-Za-z]{8}$';
$$;

revoke all on function public.create_share(text), public.get_share(text) from public;
grant execute on function public.create_share(text), public.get_share(text) to anon, authenticated;

-- ---- 2. owner edit / delete ----
-- owner_hash = hex SHA-256 of the owner's secret (128 random bits made in the browser). The secret never reaches the
-- server except when the owner edits or removes; the hash alone can't be turned back into it.
alter table public.songs add column if not exists owner_hash text check (owner_hash is null or owner_hash ~ '^[0-9a-f]{64}$');

-- Deletes the song when sha256(secret) matches. Returns true when a row was deleted.
create or replace function public.delete_own_song(song_id uuid, secret text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if secret is null or char_length(secret) < 16 or char_length(secret) > 200 then return false; end if;
  delete from public.songs s
    where s.id = delete_own_song.song_id and s.owner_hash is not null
      and s.owner_hash = encode(sha256(convert_to(delete_own_song.secret, 'UTF8')), 'hex');
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Replaces title, code (data) and meta of the owner's song, with the same limits as an insert. Returns true when updated.
create or replace function public.update_own_song(song_id uuid, secret text, title text, data text, meta jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if secret is null or char_length(secret) < 16 or char_length(secret) > 200 then return false; end if;
  if title is null or char_length(btrim(title)) not between 1 and 60 then raise exception 'The title needs 1 to 60 characters.'; end if;
  if data is null or char_length(data) not between 10 and 60000 then raise exception 'That song is too long.'; end if;
  if meta is null or pg_column_size(meta) >= 4000 then raise exception 'That song is too long.'; end if;
  update public.songs s
    set title = btrim(update_own_song.title), code = update_own_song.data, meta = update_own_song.meta
    where s.id = update_own_song.song_id and s.owner_hash is not null
      and s.owner_hash = encode(sha256(convert_to(update_own_song.secret, 'UTF8')), 'hex');
  get diagnostics n = row_count;
  return n > 0;
end $$;

revoke all on function public.delete_own_song(uuid, text), public.update_own_song(uuid, text, text, text, jsonb) from public;
grant execute on function public.delete_own_song(uuid, text), public.update_own_song(uuid, text, text, text, jsonb) to anon, authenticated;

-- Check afterwards (Table Editor / SQL editor):
--   select to_regclass('public.shares'), (select count(*) from pg_proc where proname in ('create_share','get_share','delete_own_song','update_own_song'));   -- expect shares, 4
--   select relrowsecurity from pg_class where oid = 'public.shares'::regclass;   -- expect true;  select count(*) from pg_policies where tablename = 'shares';   -- expect 0
