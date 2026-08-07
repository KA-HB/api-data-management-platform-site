-- Make monthly billing totals use QuickBooks Time's explicit Billable = Yes flag.

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
  excluded_pattern text := '(^|[[:space:]_:/-])(fringe|overhead|z[[:space:]-]*cobra([[:space:]-]*payments?)?|holiday|sick|unpaid[[:space:]-]*time[[:space:]-]*off|vacation|vaction)($|[[:space:]_:/-])';
begin
  if auth_user_id is null then
    raise exception 'Authentication required';
  end if;

  with recursive allowed_datasets as (
    select d.id
    from public.datasets d
    where d.name = 'QuickBooks Time Timesheets'
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
  latest_jobcodes as (
    select distinct on (r.json_data->>'id')
      r.json_data->>'id' as id,
      nullif(r.json_data->>'parent_id', '0') as parent_id,
      coalesce(nullif(btrim(r.json_data->>'name'), ''), nullif(btrim(r.json_data->>'short_code'), ''), 'Unassigned') as name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Job Codes'
      and nullif(r.json_data->>'id', '') is not null
    order by r.json_data->>'id', r.created_at desc
  ),
  jobcode_paths as (
    select j.id as leaf_id, j.parent_id, 0 as depth, array[j.name]::text[] as path
    from latest_jobcodes j
    union all
    select p.leaf_id, parent.parent_id, p.depth + 1, array_prepend(parent.name, p.path)
    from jobcode_paths p
    join latest_jobcodes parent on parent.id = p.parent_id
    where p.depth < 12
  ),
  resolved_jobcodes as (
    select distinct on (leaf_id)
      leaf_id,
      coalesce(nullif(btrim(path[1]), ''), 'Unassigned') as jobcode_level1,
      coalesce(nullif(btrim(path[2]), ''), 'Not specified') as jobcode_level2,
      array_to_string(path, ' / ') as full_path
    from jobcode_paths
    order by leaf_id, depth desc
  ),
  billable as materialized (
    select
      coalesce(j.jobcode_level1, 'Unassigned') as jobcode_level1,
      coalesce(j.jobcode_level2, 'Not specified') as jobcode_level2,
      r.json_data->>'user_id' as employee_id,
      r.work_date,
      coalesce(r.duration_seconds, 0) / 3600 as hours
    from public.records r
    join allowed_datasets d on d.id = r.dataset_id
    left join resolved_jobcodes j on j.leaf_id = r.json_data->>'jobcode_id'
    where r.work_date >= month_start
      and r.work_date < next_month
      and coalesce(r.duration_seconds, 0) > 0
      and lower(btrim(coalesce(r.json_data #>> '{customfields,53103}', ''))) in ('yes', 'true', '1')
      and concat_ws(' / ', j.full_path, j.jobcode_level1, j.jobcode_level2) !~* excluded_pattern
  ),
  detail as (
    select
      jobcode_level1,
      jobcode_level2,
      round(sum(hours)::numeric, 2) as hours,
      count(*)::integer as timesheets,
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
      count(*)::integer as timesheets,
      count(distinct employee_id)::integer as employees
    from billable
    group by jobcode_level1
  ),
  totals as (
    select
      coalesce(round(sum(hours)::numeric, 2), 0) as total_hours,
      count(*)::integer as total_timesheets,
      count(distinct jobcode_level1)::integer as jobcode_level1_count,
      count(distinct (jobcode_level1, jobcode_level2))::integer as jobcode_combination_count,
      (select max(last_sync) from public.qbtime_settings) as refreshed_at
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
      'Billable is not Yes', 'Fringe', 'Overhead', 'Z-Cobra Payments',
      'Holiday', 'Sick', 'Unpaid Time Off', 'Vacation'
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
