-- Keep the dashboard's active employee roster separate from employees with
-- qualifying time entries. New employees should appear in search/dropdowns and
-- the unfiltered employee total even before they have project hours.

create or replace function public.dashboard_qbtime_filter_options()
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
begin
  if auth_user_id is null then
    raise exception 'Authentication required';
  end if;

  with allowed_datasets as (
    select d.id, d.name, d.source_type
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
  has_qb_access as (
    select exists (
      select 1
      from allowed_datasets
      where source_type = 'quickbooks_time'
         or name like 'QuickBooks Time%'
    ) as allowed
  ),
  scoped as materialized (
    select e.*
    from public.dashboard_experience_unique_records e
    join allowed_datasets d on d.id = e.dataset_id
    where e.employee <> 'Unassigned'
      and e.hours > 0
  ),
  active_employees as (
    select distinct on (r.json_data->>'id')
      r.json_data->>'id' as id,
      coalesce(
        public.clean_employee_label(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')),
        public.clean_employee_label(r.json_data->>'display_name'),
        public.clean_employee_label(r.json_data->>'email'),
        public.clean_employee_label(r.json_data->>'username')
      ) as name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    cross join has_qb_access h
    where h.allowed
      and d.name = 'QuickBooks Time Employees'
      and coalesce(r.json_data->>'id', '') <> ''
      and coalesce((r.json_data->>'active')::boolean, false)
      and coalesce((r.json_data #>> '{permissions,time_tracking}')::boolean, true)
      and coalesce(r.json_data->>'term_date', '0000-00-00') in ('', '0000-00-00')
    order by r.json_data->>'id', r.created_at desc
  ),
  employees as (
    select id, name
    from active_employees
    where public.clean_employee_label(name) is not null
      and name !~ '^[0-9]+$'
      and name !~* '^user [0-9]+$'
  ),
  level1 as (
    select distinct jobcode_level1 as id, jobcode_level1 as name
    from scoped
    where public.clean_jobcode_label(jobcode_level1) is not null
  ),
  level2 as (
    select distinct
      jobcode_level2 as id,
      jobcode_level2 as name,
      jobcode_level1 as parent_id,
      jobcode_level1 as parent_name
    from scoped
    where public.clean_jobcode_label(jobcode_level2) is not null
      and public.clean_jobcode_label(jobcode_level1) is not null
  ),
  level3 as (
    select distinct
      jobcode_level3 as id,
      jobcode_level3 as name,
      jobcode_level2 as parent_id,
      jobcode_level2 as parent_name,
      jobcode_level1 as grandparent_id,
      jobcode_level1 as grandparent_name
    from scoped
    where public.clean_jobcode_label(jobcode_level3) is not null
      and public.clean_jobcode_label(jobcode_level2) is not null
      and public.clean_jobcode_label(jobcode_level1) is not null
  ),
  service_items as (
    select distinct service_item as name
    from scoped
    where coalesce(service_item, '') <> ''
      and service_item <> 'No service item'
      and public.clean_jobcode_label(service_item) is not null
  )
  select jsonb_build_object(
    'employees', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) from employees where coalesce(id, '') <> '' and coalesce(name, '') <> ''),
    'active_employee_count', (select count(*) from employees),
    'jobcode_level1', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) from level1),
    'jobcode_level2', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id, 'parent_name', parent_name) order by parent_name, name), '[]'::jsonb) from level2),
    'jobcode_level3', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id, 'parent_name', parent_name, 'grandparent_id', grandparent_id, 'grandparent_name', grandparent_name) order by grandparent_name, parent_name, name), '[]'::jsonb) from level3),
    'service_items', (select coalesce(jsonb_agg(name order by name), '[]'::jsonb) from service_items)
  ) into result;

  return result;
end;
$$;

revoke all on function public.dashboard_qbtime_filter_options() from public;
revoke all on function public.dashboard_qbtime_filter_options() from anon;
grant execute on function public.dashboard_qbtime_filter_options() to authenticated;

create or replace function public.dashboard_qbtime_rollups(
  dataset_uuid uuid default null,
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
  auth_user_id uuid := auth.uid();
  is_admin_user boolean := public.is_admin();
  keyword text := lower(coalesce(keyword_filter, ''));
begin
  if auth_user_id is null then
    raise exception 'Authentication required';
  end if;

  with allowed_datasets as (
    select d.id, d.name, d.source_type
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
      and (dataset_uuid is null or d.id = dataset_uuid)
  ),
  has_qb_access as (
    select exists (
      select 1
      from allowed_datasets
      where source_type = 'quickbooks_time'
         or name like 'QuickBooks Time%'
    ) as allowed
  ),
  active_employees as (
    select distinct on (r.json_data->>'id')
      r.json_data->>'id' as id,
      coalesce(
        public.clean_employee_label(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')),
        public.clean_employee_label(r.json_data->>'display_name'),
        public.clean_employee_label(r.json_data->>'email'),
        public.clean_employee_label(r.json_data->>'username')
      ) as name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    cross join has_qb_access h
    where h.allowed
      and d.name = 'QuickBooks Time Employees'
      and coalesce(r.json_data->>'id', '') <> ''
      and coalesce((r.json_data->>'active')::boolean, false)
      and coalesce((r.json_data #>> '{permissions,time_tracking}')::boolean, true)
      and coalesce(r.json_data->>'term_date', '0000-00-00') in ('', '0000-00-00')
    order by r.json_data->>'id', r.created_at desc
  ),
  active_employee_count as (
    select count(*)::integer as total
    from active_employees
    where public.clean_employee_label(name) is not null
      and name !~ '^[0-9]+$'
      and name !~* '^user [0-9]+$'
  ),
  scoped as materialized (
    select r.*
    from public.dashboard_experience_rollups r
    join allowed_datasets d on d.id = r.dataset_id
    where (start_date is null or r.work_date >= start_date)
      and (end_date is null or r.work_date <= end_date)
      and (coalesce(employee_filter, '') = '' or r.employee_id = employee_filter or r.employee ilike '%' || employee_filter || '%')
      and (coalesce(jobcode_level1_filter, '') = '' or r.jobcode_level1 ilike '%' || jobcode_level1_filter || '%' or r.jobcode ilike '%' || jobcode_level1_filter || '%')
      and (coalesce(jobcode_level2_filter, '') = '' or r.jobcode_level2 ilike '%' || jobcode_level2_filter || '%' or r.jobcode ilike '%' || jobcode_level2_filter || '%')
      and (coalesce(jobcode_level3_filter, '') = '' or r.jobcode_level3 ilike '%' || jobcode_level3_filter || '%' or r.jobcode ilike '%' || jobcode_level3_filter || '%')
      and (coalesce(service_item_filter, '') = '' or r.service_item ilike '%' || service_item_filter || '%')
      and (
        keyword = ''
        or r.search_text ilike '%' || keyword || '%'
      )
  ),
  totals as (
    select
      coalesce(sum(timesheets), 0)::integer as filtered_timesheets,
      coalesce(round(sum(hours)::numeric, 2), 0) as filtered_hours,
      count(distinct nullif(employee, 'Unassigned'))::integer as filtered_employees,
      count(distinct nullif(jobcode, 'Unassigned'))::integer as filtered_jobcodes,
      count(distinct nullif(service_item, 'No service item'))::integer as filtered_service_items,
      count(distinct dataset_id)::integer as dataset_count,
      min(work_date) as date_start,
      max(work_date) as date_end,
      max(refreshed_at) as refreshed_at
    from scoped
  ),
  hours_by_employee as (
    select coalesce(jsonb_agg(jsonb_build_object('employee', employee, 'hours', round(hours::numeric, 2), 'timesheets', timesheets) order by hours desc), '[]'::jsonb) as rows
    from (
      select employee, sum(hours) as hours, sum(timesheets)::integer as timesheets
      from scoped
      group by employee
      order by 2 desc
      limit 15
    ) s
  ),
  hours_by_jobcode as (
    select coalesce(jsonb_agg(jsonb_build_object('jobcode', jobcode, 'hours', round(hours::numeric, 2)) order by hours desc), '[]'::jsonb) as rows
    from (
      select coalesce(nullif(jobcode_level1, ''), nullif(jobcode, ''), 'Unassigned') as jobcode, sum(hours) as hours
      from scoped
      group by 1
      order by 2 desc
      limit 15
    ) s
  ),
  hours_by_service_item as (
    select coalesce(jsonb_agg(jsonb_build_object('service_item', service_item, 'hours', round(hours::numeric, 2)) order by hours desc), '[]'::jsonb) as rows
    from (
      select service_item, sum(hours) as hours
      from scoped
      group by service_item
      order by 2 desc
      limit 15
    ) s
  ),
  hours_by_day as (
    select coalesce(jsonb_agg(jsonb_build_object('date', work_date, 'hours', round(hours::numeric, 2)) order by work_date), '[]'::jsonb) as rows
    from (
      select work_date, sum(hours) as hours
      from scoped
      group by work_date
      order by work_date
    ) s
  ),
  records_by_dataset as (
    select coalesce(jsonb_agg(jsonb_build_object('name', dataset_name, 'records', records) order by records desc, dataset_name), '[]'::jsonb) as rows
    from (
      select dataset_name, sum(timesheets)::integer as records
      from scoped
      group by dataset_name
      order by 2 desc
      limit 12
    ) s
  ),
  records_by_day as (
    select coalesce(jsonb_agg(jsonb_build_object('date', work_date, 'records', records) order by work_date), '[]'::jsonb) as rows
    from (
      select work_date, sum(timesheets)::integer as records
      from scoped
      group by work_date
      order by work_date
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
      select employee,
        sum(hours) as hours,
        sum(timesheets)::integer as timesheets,
        count(distinct nullif(jobcode, 'Unassigned'))::integer as jobcodes,
        count(distinct nullif(service_item, 'No service item'))::integer as service_items,
        min(first_work) as first_work,
        max(last_work) as last_work
      from scoped
      group by employee
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
      select employee, jobcode_level1, jobcode_level2, jobcode_level3, jobcode, service_item,
        sum(hours) as hours,
        sum(timesheets)::integer as timesheets,
        min(first_work) as first_work,
        max(last_work) as last_work
      from scoped
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
    'records_by_dataset', (select rows from records_by_dataset),
    'records_by_day', (select rows from records_by_day),
    'employee_experience', (select rows from employee_experience),
    'experience_rows', (select rows from experience_rows),
    'filtered_timesheets', totals.filtered_timesheets,
    'filtered_hours', totals.filtered_hours,
    'filtered_employees', totals.filtered_employees,
    'active_employee_count', active_employee_count.total,
    'filtered_jobcodes', totals.filtered_jobcodes,
    'filtered_service_items', totals.filtered_service_items,
    'raw_records', totals.filtered_timesheets,
    'unique_records', totals.filtered_timesheets,
    'duplicates_removed', 0,
    'dataset_count', totals.dataset_count,
    'date_start', totals.date_start,
    'date_end', totals.date_end,
    'refreshed_at', totals.refreshed_at,
    'is_precomputed_rollup', true
  ) into result
  from totals, active_employee_count;

  return result;
end;
$$;

revoke all on function public.dashboard_qbtime_rollups(uuid, text, text, date, date, text, text, text, text) from public;
revoke all on function public.dashboard_qbtime_rollups(uuid, text, text, date, date, text, text, text, text) from anon;
grant execute on function public.dashboard_qbtime_rollups(uuid, text, text, date, date, text, text, text, text) to authenticated;
