create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

create type public.app_role as enum ('admin', 'user');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role public.app_role not null default 'user',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.datasets (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  source_type text not null default 'upload',
  created_by uuid references public.profiles(id) on delete set null,
  header_signature text,
  record_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.dataset_permissions (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.datasets(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  can_export boolean not null default true,
  created_at timestamptz not null default now(),
  unique(dataset_id, user_id)
);

create table public.records (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.datasets(id) on delete cascade,
  json_data jsonb not null,
  source_hash text,
  created_at timestamptz not null default now(),
  unique(dataset_id, source_hash)
);

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  key_hash text not null unique,
  key_name text not null,
  prefix text not null,
  revoked boolean not null default false,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.qbtime_settings (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  encrypted_secret text not null,
  redirect_uri text not null,
  tenant_info jsonb not null default '{}'::jsonb,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  last_sync timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sync_logs (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'quickbooks_time',
  status text not null,
  message text,
  stats jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index records_dataset_created_idx on public.records(dataset_id, created_at desc);
create index records_json_gin_idx on public.records using gin(json_data);
create index datasets_source_idx on public.datasets(source_type);
create index activity_user_created_idx on public.activity_logs(user_id, created_at desc);
create index api_keys_user_idx on public.api_keys(user_id, revoked);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger datasets_touch_updated_at
before update on public.datasets
for each row execute function public.touch_updated_at();

create trigger qbtime_touch_updated_at
before update on public.qbtime_settings
for each row execute function public.touch_updated_at();

create or replace function public.current_profile()
returns public.profiles
language sql
stable
security definer
set search_path = public
as $$
  select * from public.profiles where id = auth.uid() and active = true;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and active = true
  );
$$;

create or replace function public.can_access_dataset(dataset_uuid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
    or exists (
      select 1 from public.dataset_permissions
      where dataset_id = dataset_uuid and user_id = auth.uid()
    );
$$;

create or replace function public.log_activity(action_name text, details_json jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.activity_logs(user_id, action, details)
  values (auth.uid(), action_name, coalesce(details_json, '{}'::jsonb));
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles(id, email, role, active)
  values (new.id, new.email, 'user', true)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.verify_api_key(raw_key text)
returns table(user_id uuid, role public.app_role)
language plpgsql
security definer
set search_path = public
as $$
declare
  hashed text;
begin
  hashed := encode(digest(raw_key, 'sha256'), 'hex');

  return query
  update public.api_keys ak
  set last_used_at = now()
  from public.profiles p
  where ak.user_id = p.id
    and ak.key_hash = hashed
    and ak.revoked = false
    and p.active = true
  returning p.id, p.role;
end;
$$;

create or replace function public.search_dataset_records(
  dataset_uuid uuid,
  search_term text default null,
  limit_count integer default 50,
  offset_count integer default 0
)
returns table(id uuid, dataset_id uuid, json_data jsonb, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.dataset_id, r.json_data, r.created_at
  from public.records r
  where r.dataset_id = dataset_uuid
    and (
      coalesce(search_term, '') = ''
      or r.json_data::text ilike '%' || search_term || '%'
    )
  order by r.created_at desc
  limit least(greatest(limit_count, 1), 500)
  offset greatest(offset_count, 0);
$$;

alter table public.profiles enable row level security;
alter table public.datasets enable row level security;
alter table public.dataset_permissions enable row level security;
alter table public.records enable row level security;
alter table public.api_keys enable row level security;
alter table public.activity_logs enable row level security;
alter table public.qbtime_settings enable row level security;
alter table public.sync_logs enable row level security;

create policy "profiles read own or admin" on public.profiles
for select using (id = auth.uid() or public.is_admin());

create policy "profiles admin update" on public.profiles
for update using (public.is_admin()) with check (public.is_admin());

create policy "datasets read authorized" on public.datasets
for select using (public.can_access_dataset(id));

create policy "datasets admin write" on public.datasets
for all using (public.is_admin()) with check (public.is_admin());

create policy "dataset permissions admin read" on public.dataset_permissions
for select using (public.is_admin() or user_id = auth.uid());

create policy "dataset permissions admin write" on public.dataset_permissions
for all using (public.is_admin()) with check (public.is_admin());

create policy "records read authorized" on public.records
for select using (public.can_access_dataset(dataset_id));

create policy "records admin write" on public.records
for all using (public.is_admin()) with check (public.is_admin());

create policy "api keys own read" on public.api_keys
for select using (user_id = auth.uid() or public.is_admin());

create policy "api keys own insert" on public.api_keys
for insert with check (user_id = auth.uid() or public.is_admin());

create policy "api keys own update" on public.api_keys
for update using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());

create policy "activity logs admin all or own read" on public.activity_logs
for select using (public.is_admin() or user_id = auth.uid());

create policy "activity logs insert authenticated" on public.activity_logs
for insert with check (auth.uid() is not null);

create policy "qbtime settings admin" on public.qbtime_settings
for all using (public.is_admin()) with check (public.is_admin());

create policy "sync logs admin" on public.sync_logs
for all using (public.is_admin()) with check (public.is_admin());
