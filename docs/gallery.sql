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
