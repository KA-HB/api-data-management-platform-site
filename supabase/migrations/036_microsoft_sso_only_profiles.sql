-- Require Microsoft SSO users to belong to the approved organization email domain.
-- Supabase Auth should also have the Email provider disabled and Azure configured as single-tenant.

create or replace function public.is_allowed_login_email(user_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce(user_email, '')) like '%@hayatbrown.com';
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
begin
  insert into public.profiles(id, email, role, active)
  values (
    new.id,
    new.email,
    'user',
    public.is_allowed_login_email(new.email)
  )
  on conflict (id) do update
    set email = excluded.email,
        active = public.profiles.active and public.is_allowed_login_email(excluded.email);

  return new;
end;
$$;

update public.profiles
set active = false
where not public.is_allowed_login_email(email);

comment on function public.is_allowed_login_email(text)
is 'Restricts app access to Hayat Brown Microsoft tenant email addresses. Auth provider controls tenant membership; this function gates profile activation.';
