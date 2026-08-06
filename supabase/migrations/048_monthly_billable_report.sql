-- Monthly billable-hours report by Job Code 1 and Job Code 2.

create index if not exists dashboard_experience_rollups_month_job_idx
  on public.dashboard_experience_rollups (work_date, dataset_id, jobcode_level1, jobcode_level2);

create or replace function public.monthly_billable_hours(report_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  auth_user_id uuid := auth.uid();
  is_admin_user boolean := public.is_admin();
  month_start date := date_trunc('month', coalesce(report_month, current_date - interval '1 month'))::date;
  next_month date := (date_trunc('month', coalesce(report_month, current_date - interval '1 month')) + interval '1 month')::date;
  excluded_pattern text := '(^|[[:space:]_:/-])(overhead|admin|administration|administrative|vacation|vaction|sick|pto|holiday|fringe|bereavement|jury[[:space:]-]*duty|leave|time[[:space:]-]*off|comp[[:space:]-]*time|non[[:space:]-]*billable|unbillable)($|[[:space:]_:/-])';
begin
  if auth_user_id is null then
    raise exception 'Authentication required';
  end if;

  with allowed_datasets as (
    select d.id
    from public.datasets d
    where d.name <> 'QuickBooks Time PTO'
      and (
        is_admin_user
        or exists (
          select 1
          from public.dataset_permissions dp
          where dp.dataset_id = d.id
            and dp.user_id = auth_user_id
        )
      )
  ),
  billable as materialized (
    select
      coalesce(nullif(btrim(r.jobcode_level1), ''), nullif(btrim(r.jobcode), ''), 'Unassigned') as jobcode_level1,
      coalesce(nullif(btrim(r.jobcode_level2), ''), 'Not specified') as jobcode_level2,
      r.employee_id,
      r.work_date,
      r.hours,
      r.timesheets,
      r.refreshed_at
    from public.dashboard_experience_rollups r
    join allowed_datasets d on d.id = r.dataset_id
    where r.work_date >= month_start
      and r.work_date < next_month
      and r.hours > 0
      and concat_ws(' / ', r.jobcode_level1, r.jobcode_level2, r.jobcode_level3, r.jobcode, r.service_item)
        !~* excluded_pattern
  ),
  detail as (
    select
      jobcode_level1,
      jobcode_level2,
      round(sum(hours)::numeric, 2) as hours,
      sum(timesheets)::integer as timesheets,
      count(distinct employee_id)::integer as employees,
      min(work_date) as first_work,
      max(work_date) as last_work
    from billable
    group by jobcode_level1, jobcode_level2
  ),
  by_jobcode1 as (
    select
      jobcode_level1,
      round(sum(hours)::numeric, 2) as hours,
      sum(timesheets)::integer as timesheets,
      count(distinct employee_id)::integer as employees
    from billable
    group by jobcode_level1
  ),
  totals as (
    select
      coalesce(round(sum(hours)::numeric, 2), 0) as total_hours,
      coalesce(sum(timesheets), 0)::integer as total_timesheets,
      count(distinct jobcode_level1)::integer as jobcode_level1_count,
      count(distinct (jobcode_level1, jobcode_level2))::integer as jobcode_combination_count,
      max(refreshed_at) as refreshed_at
    from billable
  )
  select jsonb_build_object(
    'month_start', month_start,
    'month_end', next_month - 1,
    'generated_at', now(),
    'refreshed_at', t.refreshed_at,
    'summary', jsonb_build_object(
      'total_hours', t.total_hours,
      'total_timesheets', t.total_timesheets,
      'jobcode_level1_count', t.jobcode_level1_count,
      'jobcode_combination_count', t.jobcode_combination_count
    ),
    'by_jobcode1', coalesce((
      select jsonb_agg(to_jsonb(j) order by j.hours desc, j.jobcode_level1)
      from by_jobcode1 j
    ), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.hours desc, d.jobcode_level1, d.jobcode_level2)
      from detail d
    ), '[]'::jsonb),
    'excluded_categories', jsonb_build_array(
      'Overhead', 'Admin / Administrative', 'Vacation', 'Sick', 'PTO', 'Holiday',
      'Fringe', 'Bereavement', 'Jury Duty', 'Leave / Time Off', 'Comp Time', 'Non-billable'
    )
  )
  into result
  from totals t;

  return result;
end;
$$;

revoke all on function public.monthly_billable_hours(date) from public;
revoke all on function public.monthly_billable_hours(date) from anon;
grant execute on function public.monthly_billable_hours(date) to authenticated;
