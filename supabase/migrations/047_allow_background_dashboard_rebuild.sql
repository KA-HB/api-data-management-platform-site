-- Dashboard materialized views are rebuilt after QuickBooks imports in an
-- Edge Runtime background task. Give that maintenance operation enough time
-- to complete without exposing it as a client-callable RPC.

create or replace function public.rebuild_dashboard_experience_records()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
as $$
begin
  refresh materialized view public.dashboard_experience_records;
  refresh materialized view public.dashboard_experience_unique_records;

  if to_regclass('public.dashboard_experience_rollups') is not null then
    perform public.refresh_dashboard_experience_rollups();
  end if;
end;
$$;

revoke all on function public.rebuild_dashboard_experience_records() from public;
revoke all on function public.rebuild_dashboard_experience_records() from anon;
revoke all on function public.rebuild_dashboard_experience_records() from authenticated;
grant execute on function public.rebuild_dashboard_experience_records() to service_role;