-- Microsoft SSO profile creation must also grant regular users access to the
-- shared QuickBooks Time dashboard datasets. Admins can see everything through
-- RLS, but regular users need rows in public.dataset_permissions.

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

  if login_email is null then
    raise warning 'Auth user % did not include an email, preferred_username, or upn claim.', new.id;
    return new;
  end if;

  is_allowed := public.is_allowed_login_email(login_email);

  insert into public.profiles(id, email, role, active)
  values (
    new.id,
    login_email,
    'user',
    is_allowed
  )
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
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  login_email := public.auth_user_login_email(auth.uid());
  if login_email is null or not public.is_allowed_login_email(login_email) then
    return null;
  end if;

  insert into public.profiles(id, email, role, active)
  values (auth.uid(), login_email, 'user', true)
  on conflict (id) do update
    set email = excluded.email,
        active = public.profiles.active
  returning * into profile;

  if profile.active then
    perform public.grant_shared_qbtime_dataset_permissions(auth.uid());
  end if;

  return profile;
end;
$$;

revoke all on function public.ensure_current_profile() from public;
grant execute on function public.ensure_current_profile() to authenticated;

-- Backfill active users that existed before the Microsoft SSO trigger was restored.
select public.grant_shared_qbtime_dataset_permissions(null);
