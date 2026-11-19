create table if not exists public.it_support_admins (
  email text primary key,
  created_at timestamptz not null default now(),
  constraint it_support_admins_hayatbrown_email
    check (lower(email) ~ '^[^@]+@hayatbrown\.com$')
);

alter table public.it_support_admins enable row level security;

create or replace function public.is_it_support_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.it_support_admins a
    join public.profiles p on lower(p.email) = lower(a.email)
    where p.id = auth.uid() and p.active = true
  );
$$;

revoke all on function public.is_it_support_admin() from public;
grant execute on function public.is_it_support_admin() to authenticated;

create sequence if not exists public.it_support_ticket_number_seq;

create table if not exists public.it_support_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_number text not null unique default (
    'HB-' || extract(year from now())::text || '-' ||
    lpad(nextval('public.it_support_ticket_number_seq')::text, 5, '0')
  ),
  created_by uuid not null references public.profiles(id) on delete restrict,
  requester_email text not null,
  requester_name text not null,
  summary text not null check (char_length(summary) between 1 and 120),
  category text not null check (category in (
    'Hardware', 'Software & applications', 'Access & accounts',
    'Network & connectivity', 'New employee setup', 'Security concern', 'Other'
  )),
  priority text not null check (priority in ('High', 'Normal', 'Low')),
  status text not null default 'Open' check (status in (
    'Open', 'In progress', 'Waiting on requester', 'Resolved'
  )),
  description text not null check (char_length(description) between 1 and 20000),
  device text,
  location text,
  screenshot text check (
    screenshot is null or (screenshot like 'data:image/%' and char_length(screenshot) <= 2800000)
  ),
  response text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists it_support_tickets_requester_created_idx
  on public.it_support_tickets(created_by, created_at desc);
create index if not exists it_support_tickets_status_created_idx
  on public.it_support_tickets(status, created_at desc);

drop trigger if exists it_support_tickets_touch_updated_at on public.it_support_tickets;
create trigger it_support_tickets_touch_updated_at
before update on public.it_support_tickets
for each row execute function public.touch_updated_at();

alter table public.it_support_tickets enable row level security;

drop policy if exists "Employees see own tickets and admins see all" on public.it_support_tickets;
create policy "Employees see own tickets and admins see all"
on public.it_support_tickets for select to authenticated
using (created_by = auth.uid() or public.is_it_support_admin());

drop policy if exists "Employees submit their own tickets" on public.it_support_tickets;
create policy "Employees submit their own tickets"
on public.it_support_tickets for insert to authenticated
with check (
  created_by = auth.uid()
  and lower(requester_email) = lower((select email from public.profiles where id = auth.uid() and active = true))
);

drop policy if exists "Ticket admins update tickets" on public.it_support_tickets;
create policy "Ticket admins update tickets"
on public.it_support_tickets for update to authenticated
using (public.is_it_support_admin())
with check (public.is_it_support_admin());

grant select, insert, update on public.it_support_tickets to authenticated;
grant usage, select on sequence public.it_support_ticket_number_seq to authenticated;

