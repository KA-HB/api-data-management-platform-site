-- Azure/Microsoft SSO may put the tenant email in provider metadata instead of auth.users.email.
-- These helpers keep the app profile gate aligned with the signed-in Microsoft account.

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

revoke all on function public.auth_user_login_email(uuid) from public;
grant execute on function public.auth_user_login_email(uuid) to authenticated;
grant execute on function public.auth_user_login_email(uuid) to service_role;

create or replace function public.is_allowed_login_email(user_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce(user_email, '')) ~ '^[^@]+@hayatbrown\.com$';
$$;

revoke all on function public.is_allowed_login_email(text) from public;
grant execute on function public.is_allowed_login_email(text) to authenticated;
grant execute on function public.is_allowed_login_email(text) to service_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  login_email text;
begin
  login_email := public.auth_user_login_email(new.id);

  if login_email is null then
    raise warning 'Auth user % did not include an email, preferred_username, or upn claim.', new.id;
    return new;
  end if;

  insert into public.profiles(id, email, role, active)
  values (
    new.id,
    login_email,
    'user',
    public.is_allowed_login_email(login_email)
  )
  on conflict (id) do update
    set email = excluded.email,
        active = public.is_allowed_login_email(excluded.email);

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

  return profile;
end;
$$;

revoke all on function public.ensure_current_profile() from public;
grant execute on function public.ensure_current_profile() to authenticated;
