-- The QuickBooks Time Edge Function calls refresh_dashboard_experience_records()
-- at the end of every sync. The full materialized-view rebuild can exceed the
-- database statement timeout, which causes the user-facing sync request to
-- return a generic 500 even after QuickBooks data was successfully imported.
--
-- Keep the sync-called function fast/nonblocking, and preserve the full rebuild
-- as a separate manual maintenance RPC.

create or replace function public.rebuild_dashboard_experience_records()
returns void
language plpgsql
security definer
set search_path = public
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
grant execute on function public.rebuild_dashboard_experience_records() to authenticated;

create or replace function public.refresh_dashboard_experience_records()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Intentionally fast. This function is called during QuickBooks Time sync and
  -- must not block or fail the sync if the dashboard rebuild is too expensive.
  -- Run public.rebuild_dashboard_experience_records() manually when a full
  -- materialized dashboard rebuild is needed.
  return;
end;
$$;

revoke all on function public.refresh_dashboard_experience_records() from public;
revoke all on function public.refresh_dashboard_experience_records() from anon;
grant execute on function public.refresh_dashboard_experience_records() to authenticated;
