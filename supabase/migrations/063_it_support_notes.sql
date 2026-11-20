-- Internal, append-only notes and status audit trail for the IT Service Desk.
create table if not exists public.it_support_ticket_notes (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.it_support_tickets(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  author_email text not null,
  author_name text not null,
  note text not null check (char_length(note) between 1 and 5000),
  created_at timestamptz not null default now()
);

create index if not exists it_support_ticket_notes_ticket_created_idx
  on public.it_support_ticket_notes(ticket_id, created_at desc);

alter table public.it_support_ticket_notes enable row level security;

drop policy if exists "IT admins read ticket notes" on public.it_support_ticket_notes;
create policy "IT admins read ticket notes"
on public.it_support_ticket_notes for select to authenticated
using (public.is_it_support_admin());

drop policy if exists "IT admins add ticket notes" on public.it_support_ticket_notes;
create policy "IT admins add ticket notes"
on public.it_support_ticket_notes for insert to authenticated
with check (
  public.is_it_support_admin()
  and author_id = auth.uid()
  and lower(author_email) = lower((select email from public.profiles where id = auth.uid() and active = true))
);

grant select, insert on public.it_support_ticket_notes to authenticated;

create or replace function public.log_it_support_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_email text;
begin
  if old.status is distinct from new.status then
    select p.email into actor_email from public.profiles p where p.id = auth.uid();
    insert into public.it_support_ticket_notes
      (ticket_id, author_id, author_email, author_name, note)
    values
      (new.id, auth.uid(), coalesce(actor_email, 'service-desk@hayatbrown.com'),
       coalesce(actor_email, 'Service desk'),
       format('Status changed from %s to %s.', old.status, new.status));
  end if;
  return new;
end;
$$;

drop trigger if exists it_support_tickets_log_status_change on public.it_support_tickets;
create trigger it_support_tickets_log_status_change
after update of status on public.it_support_tickets
for each row execute function public.log_it_support_status_change();

revoke all on function public.log_it_support_status_change() from public;

