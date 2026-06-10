alter extension pg_trgm set schema extensions;

create or replace function public.safe_date(value text)
returns date
language plpgsql
immutable
set search_path = public
as $$
begin
  if value is null or btrim(value) = '' or value = '0000-00-00' then
    return null;
  end if;
  return value::date;
exception when others then
  return null;
end;
$$;

drop policy if exists "api keys no direct access" on public.api_keys;
create policy "api keys no direct access" on public.api_keys
for all using (false) with check (false);

drop policy if exists "qbtime settings no direct access" on public.qbtime_settings;
create policy "qbtime settings no direct access" on public.qbtime_settings
for all using (false) with check (false);

revoke execute on function public.can_access_dataset(uuid) from anon;
revoke execute on function public.current_profile() from anon;
revoke execute on function public.current_user_role() from anon;
revoke execute on function public.dashboard_qbtime_rollups() from anon;
revoke execute on function public.dashboard_summary() from anon;
revoke execute on function public.handle_new_user() from anon;
revoke execute on function public.is_admin() from anon;
revoke execute on function public.log_activity(text, jsonb) from anon;
revoke execute on function public.search_dataset_records(uuid, text, integer, integer) from anon;
revoke execute on function public.search_records_advanced(uuid, text, text, text, timestamptz, timestamptz, text, text, text, text, boolean, text, text, text, integer, integer) from anon;
revoke execute on function public.verify_api_key(text) from anon;
