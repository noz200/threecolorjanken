-- 三色じゃんけん GitHub Pages + Supabase 版
-- Supabase SQL Editorでこのファイルをそのまま実行してください。
-- 既に旧版を実行済みでも、もう一度このSQLを実行すれば2人/3人対応カラムと関数が更新されます。

create table if not exists public.tcj_waiting (
  player_id text primary key,
  name text not null,
  desired_player_count integer not null default 3,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  visible boolean not null default true
);

create table if not exists public.tcj_games (
  id uuid primary key default gen_random_uuid(),
  player_count integer not null default 3,
  status text not null default 'playing',
  phase text not null default 'playing',
  round integer not null default 1,
  order_ids jsonb not null default '[]'::jsonb,
  turn_index integer not null default 0,
  players jsonb not null default '[]'::jsonb,
  submissions jsonb not null default '[]'::jsonb,
  reveal jsonb,
  phase_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tcj_presence (
  player_id text primary key,
  name text not null,
  game_id uuid,
  mode text not null,
  visible boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.tcj_waiting
  add column if not exists desired_player_count integer not null default 3;

alter table public.tcj_games
  add column if not exists player_count integer not null default 3;

do $$
begin
  alter table public.tcj_waiting
    add constraint tcj_waiting_desired_player_count_check
    check (desired_player_count in (2, 3));
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  alter table public.tcj_games
    add constraint tcj_games_player_count_check
    check (player_count in (2, 3));
exception
  when duplicate_object then null;
end;
$$;

create or replace function public.tcj_create_deck()
returns jsonb
language sql
stable
as $$
  select jsonb_agg(
    jsonb_build_object(
      'id', color || '-' || hand,
      'color', color,
      'hand', hand
    )
    order by color_order, hand_order
  )
  from (
    values
      ('white', 1),
      ('blue', 2),
      ('red', 3)
  ) as colors(color, color_order)
  cross join (
    values
      ('rock', 1),
      ('scissors', 2),
      ('paper', 3)
  ) as hands(hand, hand_order);
$$;

create or replace function public.tcj_try_match(p_player_id text, p_player_count integer default 3)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_players jsonb;
  selected_count integer;
  created_game_id uuid;
  match_count integer;
begin
  match_count := least(3, greatest(2, coalesce(p_player_count, 3)));

  lock table public.tcj_waiting in exclusive mode;

  delete from public.tcj_waiting
  where updated_at < now() - interval '30 seconds'
     or (visible = false and updated_at < now() - interval '18 seconds');

  if not exists (
    select 1
    from public.tcj_waiting
    where player_id = p_player_id
      and desired_player_count = match_count
      and visible = true
      and updated_at >= now() - interval '30 seconds'
  ) then
    return null;
  end if;

  with candidates as (
    select player_id, name, joined_at
    from public.tcj_waiting
    where visible = true
      and updated_at >= now() - interval '30 seconds'
      and desired_player_count = match_count
    order by joined_at asc
    limit match_count
    for update
  )
  select
    count(*),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', player_id,
          'name', name,
          'score', 0,
          'deck', public.tcj_create_deck()
        )
        order by joined_at asc
      ),
      '[]'::jsonb
    )
  into selected_count, selected_players
  from candidates;

  if selected_count < match_count then
    return null;
  end if;

  insert into public.tcj_games (
    player_count,
    status,
    phase,
    round,
    order_ids,
    turn_index,
    players,
    submissions
  )
  values (
    match_count,
    'playing',
    'playing',
    1,
    (
      select jsonb_agg(player_item.value ->> 'id')
      from jsonb_array_elements(selected_players) as player_item(value)
    ),
    0,
    selected_players,
    '[]'::jsonb
  )
  returning id into created_game_id;

  delete from public.tcj_waiting
  where player_id in (
    select player_item.value ->> 'id'
    from jsonb_array_elements(selected_players) as player_item(value)
  );

  return created_game_id;
end;
$$;

alter table public.tcj_waiting enable row level security;
alter table public.tcj_games enable row level security;
alter table public.tcj_presence enable row level security;

drop policy if exists "tcj_waiting_public_all" on public.tcj_waiting;
create policy "tcj_waiting_public_all"
on public.tcj_waiting
for all
to anon
using (true)
with check (true);

drop policy if exists "tcj_games_public_all" on public.tcj_games;
create policy "tcj_games_public_all"
on public.tcj_games
for all
to anon
using (true)
with check (true);

drop policy if exists "tcj_presence_public_all" on public.tcj_presence;
create policy "tcj_presence_public_all"
on public.tcj_presence
for all
to anon
using (true)
with check (true);

grant select, insert, update, delete on public.tcj_waiting to anon;
grant select, insert, update, delete on public.tcj_games to anon;
grant select, insert, update, delete on public.tcj_presence to anon;
grant execute on function public.tcj_create_deck() to anon;
grant execute on function public.tcj_try_match(text, integer) to anon;

do $$
begin
  alter publication supabase_realtime add table public.tcj_waiting;
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.tcj_games;
exception
  when duplicate_object then null;
end;
$$;
