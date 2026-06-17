insert into public.dataset_permissions (dataset_id, user_id, can_export)
select d.id, p.id, true
from public.datasets d
cross join public.profiles p
where p.active = true
  and d.name <> 'QuickBooks Time PTO'
  and (
    d.source_type = 'quickbooks_time'
    or d.name ilike 'QuickBooks Time %'
  )
on conflict (dataset_id, user_id) do update
set can_export = excluded.can_export;

create or replace function public.grant_shared_qbtime_dataset_permissions(target_user_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  granted_count integer;
begin
  insert into public.dataset_permissions (dataset_id, user_id, can_export)
  select d.id, p.id, true
  from public.datasets d
  cross join public.profiles p
  where p.active = true
    and (target_user_id is null or p.id = target_user_id)
    and d.name <> 'QuickBooks Time PTO'
    and (
      d.source_type = 'quickbooks_time'
      or d.name ilike 'QuickBooks Time %'
    )
  on conflict (dataset_id, user_id) do update
  set can_export = excluded.can_export;

  get diagnostics granted_count = row_count;
  return granted_count;
end;
$$;

revoke all on function public.grant_shared_qbtime_dataset_permissions(uuid) from public;
grant execute on function public.grant_shared_qbtime_dataset_permissions(uuid) to authenticated;

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

  perform public.grant_shared_qbtime_dataset_permissions(new.id);
  return new;
end;
$$;
