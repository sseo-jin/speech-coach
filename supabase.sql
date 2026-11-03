-- Run once in Supabase → SQL Editor. Each user sees and changes only their own scores (row level security).
create table if not exists public.scores (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  script_key text not null,
  score int not null,
  takes int,
  stuck int,
  created_at timestamptz not null default now()
);
alter table public.scores enable row level security;
drop policy if exists "own scores" on public.scores;
create policy "own scores" on public.scores for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists scores_user_script on public.scores (user_id, script_key, created_at);

-- sentences stuck on in each run (indexes into the script), for "Sentences you miss most often"
alter table public.scores add column if not exists missed smallint[] not null default '{}';
