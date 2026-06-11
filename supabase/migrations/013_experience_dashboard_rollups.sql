drop function if exists public.dashboard_qbtime_rollups(text, date, date, text, text, text, text);
drop function if exists public.dashboard_qbtime_rollups(text, text, date, date, text, text, text, text);

create or replace function public.dashboard_qbtime_rollups(
  keyword_filter text default null,
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
      coalesce(nullif(trim(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')), ''), r.json_data->>'email', r.json_data->>'id') as employee_name
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
    select
      t.*,
      e.employee_name,
      jp.jobcode_name,
      jp.level1_id,
      jp.level1_name,
      jp.level2_id,
      jp.level2_name,
      jp.level3_id,
      jp.level3_name,
      coalesce((t.json_data->>'duration')::numeric, 0) / 3600 as hours
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
      and (
        coalesce(keyword_filter, '') = ''
        or e.employee_name ilike '%' || keyword_filter || '%'
        or jp.level1_name ilike '%' || keyword_filter || '%'
        or jp.level2_name ilike '%' || keyword_filter || '%'
        or jp.level3_name ilike '%' || keyword_filter || '%'
        or jp.jobcode_name ilike '%' || keyword_filter || '%'
        or t.service_item ilike '%' || keyword_filter || '%'
        or t.json_data->>'notes' ilike '%' || keyword_filter || '%'
      )
  ),
  hours_by_employee as (
    select coalesce(jsonb_agg(jsonb_build_object('employee', employee, 'hours', round(hours::numeric, 2)) order by hours desc), '[]'::jsonb) as rows
    from (
      select coalesce(employee_name, json_data->>'user_id', 'Unassigned') as employee, sum(hours) as hours
      from filtered
      group by 1
      order by 2 desc
      limit 15
    ) s
  ),
  hours_by_jobcode as (
    select coalesce(jsonb_agg(jsonb_build_object('jobcode', jobcode, 'hours', round(hours::numeric, 2)) order by hours desc), '[]'::jsonb) as rows
    from (
      select coalesce(concat_ws(' / ', nullif(level1_name, ''), nullif(level2_name, ''), nullif(level3_name, '')), jobcode_name, json_data->>'jobcode_id', 'Unassigned') as jobcode,
        sum(hours) as hours
      from filtered
      group by 1
      order by 2 desc
      limit 15
    ) s
  ),
  hours_by_service_item as (
    select coalesce(jsonb_agg(jsonb_build_object('service_item', service_item, 'hours', round(hours::numeric, 2)) order by hours desc), '[]'::jsonb) as rows
    from (
      select coalesce(nullif(service_item, ''), 'No service item') as service_item, sum(hours) as hours
      from filtered
      group by 1
      order by 2 desc
      limit 15
    ) s
  ),
  hours_by_day as (
    select coalesce(jsonb_agg(jsonb_build_object('date', work_date, 'hours', round(hours::numeric, 2)) order by work_date), '[]'::jsonb) as rows
    from (
      select work_date, sum(hours) as hours
      from filtered
      where work_date is not null
      group by 1
      order by 1
    ) s
  ),
  employee_experience as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'employee', employee,
      'hours', round(hours::numeric, 2),
      'timesheets', timesheets,
      'jobcodes', jobcodes,
      'service_items', service_items,
      'first_work', first_work,
      'last_work', last_work
    ) order by hours desc), '[]'::jsonb) as rows
    from (
      select coalesce(employee_name, json_data->>'user_id', 'Unassigned') as employee,
        sum(hours) as hours,
        count(*)::int as timesheets,
        count(distinct json_data->>'jobcode_id')::int as jobcodes,
        count(distinct nullif(service_item, ''))::int as service_items,
        min(work_date) as first_work,
        max(work_date) as last_work
      from filtered
      group by 1
      order by 2 desc
      limit 50
    ) s
  ),
  experience_rows as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'employee', employee,
      'jobcode_level1', jobcode_level1,
      'jobcode_level2', jobcode_level2,
      'jobcode_level3', jobcode_level3,
      'jobcode', jobcode,
      'service_item', service_item,
      'hours', round(hours::numeric, 2),
      'timesheets', timesheets,
      'first_work', first_work,
      'last_work', last_work
    ) order by hours desc), '[]'::jsonb) as rows
    from (
      select
        coalesce(employee_name, json_data->>'user_id', 'Unassigned') as employee,
        level1_name as jobcode_level1,
        level2_name as jobcode_level2,
        level3_name as jobcode_level3,
        coalesce(jobcode_name, json_data->>'jobcode_id', 'Unassigned') as jobcode,
        coalesce(nullif(service_item, ''), 'No service item') as service_item,
        sum(hours) as hours,
        count(*)::int as timesheets,
        min(work_date) as first_work,
        max(work_date) as last_work
      from filtered
      group by 1, 2, 3, 4, 5, 6
      order by 7 desc
      limit 100
    ) s
  )
  select jsonb_build_object(
    'hours_by_employee', (select rows from hours_by_employee),
    'hours_by_jobcode', (select rows from hours_by_jobcode),
    'hours_by_service_item', (select rows from hours_by_service_item),
    'hours_by_day', (select rows from hours_by_day),
    'employee_experience', (select rows from employee_experience),
    'experience_rows', (select rows from experience_rows),
    'filtered_timesheets', (select count(*) from filtered),
    'filtered_hours', (select coalesce(round(sum(hours)::numeric, 2), 0) from filtered),
    'filtered_employees', (select count(distinct json_data->>'user_id') from filtered),
    'filtered_jobcodes', (select count(distinct json_data->>'jobcode_id') from filtered),
    'filtered_service_items', (select count(distinct nullif(service_item, '')) from filtered),
    'date_start', (select min(work_date) from filtered),
    'date_end', (select max(work_date) from filtered)
  ) into result;

  return result;
end;
$$;

revoke all on function public.dashboard_qbtime_rollups(text, text, date, date, text, text, text, text) from public;
grant execute on function public.dashboard_qbtime_rollups(text, text, date, date, text, text, text, text) to authenticated;
