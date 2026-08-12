-- Employee and service-item detail for a selected monthly report line.

create or replace function public.monthly_job_hours_breakdown(
  report_month date,
  selected_jobcode_level1 text,
  selected_jobcode_level2 text
)
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
begin
  if auth_user_id is null then
    raise exception 'Authentication required';
  end if;

  if coalesce(btrim(selected_jobcode_level1), '') = '' or coalesce(btrim(selected_jobcode_level2), '') = '' then
    raise exception 'Job Code 1 and Job Code 2 are required';
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
  latest_employees as (
    select distinct on (r.json_data->>'id')
      r.json_data->>'id' as employee_id,
      coalesce(
        public.clean_employee_label(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')),
        public.clean_employee_label(r.json_data->>'display_name'),
        public.clean_employee_label(r.json_data->>'email'),
        public.clean_employee_label(r.json_data->>'username')
      ) as employee_name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Employees'
      and coalesce(r.json_data->>'id', '') <> ''
    order by r.json_data->>'id', r.created_at desc
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
      coalesce(nullif(btrim(path[2]), ''), 'Not specified') as jobcode_level2
    from jobcode_paths
    order by leaf_id, depth desc
  ),
  timesheet_base as materialized (
    select
      r.json_data,
      r.work_date,
      coalesce(r.duration_seconds, 0) / 3600.0 as hours,
      string_to_array(coalesce(nullif(r.json_data #>> '{customfields,53105}', ''), ''), ':') as service_parts
    from public.records r
    join allowed_datasets d on d.id = r.dataset_id
    where r.work_date >= month_start
      and r.work_date < next_month
      and coalesce(r.duration_seconds, 0) > 0
  ),
  monthly_entries as materialized (
    select
      coalesce(j.jobcode_level1, 'Unassigned') as jobcode_level1,
      coalesce(j.jobcode_level2, 'Not specified') as jobcode_level2,
      t.json_data->>'user_id' as employee_id,
      coalesce(
        e.employee_name,
        public.clean_employee_label(t.json_data->>'employee_name'),
        public.clean_employee_label(t.json_data->>'username'),
        'Employee ' || coalesce(t.json_data->>'user_id', 'unknown')
      ) as employee,
      coalesce(
        public.clean_jobcode_label(nullif(btrim(t.service_parts[array_length(t.service_parts, 1)]), '')),
        public.clean_jobcode_label(t.json_data->>'service item'),
        public.clean_jobcode_label(t.json_data->>'service_item'),
        'No service item'
      ) as service_item,
      lower(btrim(coalesce(t.json_data #>> '{customfields,53103}', ''))) in ('yes', 'true', '1') as is_billable,
      t.work_date,
      t.hours
    from timesheet_base t
    left join resolved_jobcodes j on j.leaf_id = t.json_data->>'jobcode_id'
    left join latest_employees e on e.employee_id = t.json_data->>'user_id'
  ),
  selected_entries as materialized (
    select *
    from monthly_entries e
    where e.jobcode_level1 = selected_jobcode_level1
      and e.jobcode_level2 = selected_jobcode_level2
  ),
  detail as (
    select
      employee,
      employee_id,
      jobcode_level1,
      jobcode_level2,
      service_item,
      is_billable,
      round(sum(hours)::numeric, 2) as hours,
      count(*)::integer as timesheets,
      min(work_date) as first_work,
      max(work_date) as last_work
    from selected_entries
    group by employee, employee_id, jobcode_level1, jobcode_level2, service_item, is_billable
  ),
  totals as (
    select
      coalesce(round((sum(hours) filter (where is_billable))::numeric, 2), 0) as billable_hours,
      coalesce(round((sum(hours) filter (where not is_billable))::numeric, 2), 0) as nonbillable_hours,
      count(*) filter (where is_billable)::integer as billable_entries,
      count(*) filter (where not is_billable)::integer as nonbillable_entries,
      count(distinct employee_id)::integer as employee_count
    from selected_entries
  )
  select jsonb_build_object(
    'month_start', month_start,
    'month_end', next_month - 1,
    'jobcode_level1', selected_jobcode_level1,
    'jobcode_level2', selected_jobcode_level2,
    'summary', jsonb_build_object(
      'billable_hours', t.billable_hours,
      'nonbillable_hours', t.nonbillable_hours,
      'billable_entries', t.billable_entries,
      'nonbillable_entries', t.nonbillable_entries,
      'employee_count', t.employee_count
    ),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.is_billable asc, d.hours desc, d.employee, d.service_item)
      from detail d
    ), '[]'::jsonb)
  )
  into result
  from totals t;

  return result;
end;
$$;

revoke all on function public.monthly_job_hours_breakdown(date, text, text) from public;
revoke all on function public.monthly_job_hours_breakdown(date, text, text) from anon;
grant execute on function public.monthly_job_hours_breakdown(date, text, text) to authenticated;
