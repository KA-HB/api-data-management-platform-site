-- Ensure every active Hayat Brown SSO user receives shared QuickBooks Time data access.

create or replace function public.auth_user_login_email(user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(nullif(coalesce(
    u.email,
    u.raw_user_meta_data->>'email',
    u.raw_user_meta_data->>'preferred_username',
    u.raw_user_meta_data->>'upn',
    u.raw_user_meta_data->>'userPrincipalName'
  ), ''))
  from auth.users u
  where u.id = user_id;
$$;

create or replace function public.is_allowed_login_email(user_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce(user_email, '')) ~ '^[^@]+@hayatbrown\.com$';
$$;

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

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  login_email text;
  is_allowed boolean;
begin
  login_email := public.auth_user_login_email(new.id);
  if login_email is null then return new; end if;

  is_allowed := public.is_allowed_login_email(login_email);
  insert into public.profiles(id, email, role, active)
  values (new.id, login_email, 'user', is_allowed)
  on conflict (id) do update
    set email = excluded.email,
        active = public.profiles.active and is_allowed;

  if is_allowed then
    perform public.grant_shared_qbtime_dataset_permissions(new.id);
  end if;
  return new;
end;
$$;

create or replace function public.ensure_current_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  login_email text;
  profile public.profiles;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  login_email := public.auth_user_login_email(auth.uid());
  if login_email is null or not public.is_allowed_login_email(login_email) then return null; end if;

  insert into public.profiles(id, email, role, active)
  values (auth.uid(), login_email, 'user', true)
  on conflict (id) do update
    set email = excluded.email,
        active = public.profiles.active
  returning * into profile;

  if profile.active then
    perform public.grant_shared_qbtime_dataset_permissions(profile.id);
  end if;
  return profile;
end;
$$;

create or replace function public.grant_qbtime_permissions_for_dataset()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.name <> 'QuickBooks Time PTO'
    and (new.source_type = 'quickbooks_time' or new.name ilike 'QuickBooks Time %') then
    insert into public.dataset_permissions (dataset_id, user_id, can_export)
    select new.id, p.id, true
    from public.profiles p
    where p.active = true
    on conflict (dataset_id, user_id) do update
    set can_export = excluded.can_export;
  end if;
  return new;
end;
$$;

drop trigger if exists datasets_grant_shared_qbtime_access on public.datasets;
create trigger datasets_grant_shared_qbtime_access
after insert or update of name, source_type on public.datasets
for each row execute function public.grant_qbtime_permissions_for_dataset();

revoke all on function public.auth_user_login_email(uuid) from public;
revoke all on function public.is_allowed_login_email(text) from public;
revoke all on function public.grant_shared_qbtime_dataset_permissions(uuid) from public;
revoke all on function public.ensure_current_profile() from public;
revoke all on function public.grant_qbtime_permissions_for_dataset() from public;
grant execute on function public.auth_user_login_email(uuid) to authenticated, service_role;
grant execute on function public.is_allowed_login_email(text) to authenticated, service_role;
grant execute on function public.grant_shared_qbtime_dataset_permissions(uuid) to authenticated, service_role;
grant execute on function public.ensure_current_profile() to authenticated;

select public.grant_shared_qbtime_dataset_permissions(null);
notify pgrst, 'reload schema';
