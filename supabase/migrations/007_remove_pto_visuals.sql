create or replace function public.dashboard_qbtime_rollups(
  employee_filter text default null,
  start_date date default null,
  end_date date default null,
  jobcode_level1_filter text default null,
  jobcode_level2_filter text default null,
  jobcode_level3_filter text default null,
  service_item_filter text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admin role required';
  end if;

  with employees as (
    select (r.json_data->>'id')::text as employee_id,
      nullif(trim(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')), '') as employee_name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Employees'
  ),
  jobcodes as (
    select
      (r.json_data->>'id')::text as jobcode_id,
      nullif(r.json_data->>'parent_id', '0') as parent_id,
      coalesce(r.json_data->>'name', r.json_data->>'short_code', r.json_data->>'id') as jobcode_name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Job Codes'
  ),
  job_paths as (
    select
      leaf.jobcode_id,
      coalesce(root.jobcode_id, parent.jobcode_id, leaf.jobcode_id) as level1_id,
      coalesce(root.jobcode_name, parent.jobcode_name, leaf.jobcode_name) as level1_name,
      case when root.jobcode_id is null then null else parent.jobcode_id end as level2_id,
      case when root.jobcode_id is null then null else parent.jobcode_name end as level2_name,
      case when root.jobcode_id is null and parent.jobcode_id is null then null when root.jobcode_id is null then null else leaf.jobcode_id end as level3_id,
      case when root.jobcode_id is null and parent.jobcode_id is null then null when root.jobcode_id is null then null else leaf.jobcode_name end as level3_name,
      leaf.jobcode_name
    from jobcodes leaf
    left join jobcodes parent on parent.jobcode_id = leaf.parent_id
    left join jobcodes root on root.jobcode_id = parent.parent_id
  ),
  timesheets as (
    select
      r.json_data,
      public.safe_date(r.json_data->>'date') as work_date,
      r.json_data #>> '{customfields,53105}' as service_item
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Timesheets'
  ),
  filtered as (
    select t.*, e.employee_name, jp.jobcode_name, jp.level1_id, jp.level1_name, jp.level2_id, jp.level2_name, jp.level3_id, jp.level3_name
    from timesheets t
    left join employees e on e.employee_id = t.json_data->>'user_id'
    left join job_paths jp on jp.jobcode_id = t.json_data->>'jobcode_id'
    where (coalesce(employee_filter, '') = '' or t.json_data->>'user_id' = employee_filter or e.employee_name ilike '%' || employee_filter || '%')
      and (start_date is null or t.work_date >= start_date)
      and (end_date is null or t.work_date <= end_date)
      and (coalesce(jobcode_level1_filter, '') = '' or jp.level1_id = jobcode_level1_filter or jp.level1_name ilike '%' || jobcode_level1_filter || '%')
      and (coalesce(jobcode_level2_filter, '') = '' or jp.level2_id = jobcode_level2_filter or jp.level2_name ilike '%' || jobcode_level2_filter || '%')
      and (coalesce(jobcode_level3_filter, '') = '' or jp.level3_id = jobcode_level3_filter or jp.level3_name ilike '%' || jobcode_level3_filter || '%')
      and (coalesce(service_item_filter, '') = '' or t.service_item ilike '%' || service_item_filter || '%')
  ),
  hours_by_employee as (
    select coalesce(jsonb_agg(jsonb_build_object('employee', employee, 'hours', round(hours::numeric, 2)) order by hours desc), '[]'::jsonb) as rows
    from (
      select coalesce(employee_name, json_data->>'user_id', 'Unassigned') as employee,
        sum(coalesce((json_data->>'duration')::numeric, 0)) / 3600 as hours
      from filtered
      group by 1
      order by 2 desc
      limit 12
    ) s
  ),
  hours_by_jobcode as (
    select coalesce(jsonb_agg(jsonb_build_object('jobcode', jobcode, 'hours', round(hours::numeric, 2)) order by hours desc), '[]'::jsonb) as rows
    from (
      select coalesce(jobcode_name, json_data->>'jobcode_id', 'Unassigned') as jobcode,
        sum(coalesce((json_data->>'duration')::numeric, 0)) / 3600 as hours
      from filtered
      group by 1
      order by 2 desc
      limit 12
    ) s
  ),
  hours_by_service_item as (
    select coalesce(jsonb_agg(jsonb_build_object('service_item', service_item, 'hours', round(hours::numeric, 2)) order by hours desc), '[]'::jsonb) as rows
    from (
      select coalesce(nullif(service_item, ''), 'No service item') as service_item,
        sum(coalesce((json_data->>'duration')::numeric, 0)) / 3600 as hours
      from filtered
      group by 1
      order by 2 desc
      limit 12
    ) s
  ),
  hours_by_day as (
    select coalesce(jsonb_agg(jsonb_build_object('date', work_date, 'hours', round(hours::numeric, 2)) order by work_date), '[]'::jsonb) as rows
    from (
      select work_date, sum(coalesce((json_data->>'duration')::numeric, 0)) / 3600 as hours
      from filtered
      where work_date is not null
      group by 1
      order by 1
    ) s
  )
  select jsonb_build_object(
    'hours_by_employee', (select rows from hours_by_employee),
    'hours_by_jobcode', (select rows from hours_by_jobcode),
    'hours_by_service_item', (select rows from hours_by_service_item),
    'hours_by_day', (select rows from hours_by_day),
    'filtered_timesheets', (select count(*) from filtered),
    'filtered_hours', (select round((sum(coalesce((json_data->>'duration')::numeric, 0)) / 3600)::numeric, 2) from filtered)
  ) into result;

  return result;
end;
$$;
