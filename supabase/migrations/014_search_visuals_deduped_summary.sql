create or replace function public.safe_numeric(value text)
returns numeric
language plpgsql
immutable
as $$
begin
  if value is null or btrim(value) = '' then
    return null;
  end if;
  return value::numeric;
exception when others then
  return null;
end;
$$;

create or replace function public.dashboard_qbtime_filter_options()
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
    select distinct
      (r.json_data->>'id')::text as id,
      coalesce(nullif(trim(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')), ''), r.json_data->>'email', r.json_data->>'id') as name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Employees'
    union
    select distinct
      coalesce(nullif(trim(concat(r.json_data->>'fname', ' ', r.json_data->>'lname')), ''), r.json_data->>'username') as id,
      coalesce(nullif(trim(concat(r.json_data->>'fname', ' ', r.json_data->>'lname')), ''), r.json_data->>'username') as name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name <> 'QuickBooks Time PTO'
      and coalesce(nullif(trim(concat(r.json_data->>'fname', ' ', r.json_data->>'lname')), ''), r.json_data->>'username') is not null
  ),
  jobcodes as (
    select
      (r.json_data->>'id')::text as id,
      nullif(r.json_data->>'parent_id', '0') as parent_id,
      coalesce(r.json_data->>'name', r.json_data->>'short_code', r.json_data->>'id') as name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Job Codes'
  ),
  level1 as (
    select id, name from jobcodes where parent_id is null
    union
    select distinct r.json_data->>'jobcode_1' as id, r.json_data->>'jobcode_1' as name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name <> 'QuickBooks Time PTO' and coalesce(r.json_data->>'jobcode_1', '') <> ''
  ),
  level2 as (
    select j.id, j.name, p.id as parent_id, p.name as parent_name
    from jobcodes j
    join jobcodes p on p.id = j.parent_id
    where p.parent_id is null
    union
    select distinct r.json_data->>'jobcode_2' as id, r.json_data->>'jobcode_2' as name, r.json_data->>'jobcode_1' as parent_id, r.json_data->>'jobcode_1' as parent_name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name <> 'QuickBooks Time PTO' and coalesce(r.json_data->>'jobcode_2', '') <> ''
  ),
  level3 as (
    select j.id, j.name, p.id as parent_id, p.name as parent_name, gp.id as grandparent_id, gp.name as grandparent_name
    from jobcodes j
    join jobcodes p on p.id = j.parent_id
    join jobcodes gp on gp.id = p.parent_id
    where gp.parent_id is null
    union
    select distinct r.json_data->>'jobcode_3' as id, r.json_data->>'jobcode_3' as name, r.json_data->>'jobcode_2' as parent_id, r.json_data->>'jobcode_2' as parent_name, r.json_data->>'jobcode_1' as grandparent_id, r.json_data->>'jobcode_1' as grandparent_name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name <> 'QuickBooks Time PTO' and coalesce(r.json_data->>'jobcode_3', '') <> ''
  ),
  service_items as (
    select distinct coalesce(nullif(r.json_data #>> '{customfields,53105}', ''), nullif(r.json_data->>'service item', ''), nullif(r.json_data->>'service_item', '')) as name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name <> 'QuickBooks Time PTO'
      and coalesce(nullif(r.json_data #>> '{customfields,53105}', ''), nullif(r.json_data->>'service item', ''), nullif(r.json_data->>'service_item', '')) is not null
  )
  select jsonb_build_object(
    'employees', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) from employees where coalesce(name, '') <> ''),
    'jobcode_level1', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) from level1 where coalesce(name, '') <> ''),
    'jobcode_level2', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id, 'parent_name', parent_name) order by parent_name, name), '[]'::jsonb) from level2 where coalesce(name, '') <> ''),
    'jobcode_level3', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id, 'parent_name', parent_name, 'grandparent_id', grandparent_id, 'grandparent_name', grandparent_name) order by grandparent_name, parent_name, name), '[]'::jsonb) from level3 where coalesce(name, '') <> ''),
    'service_items', (select coalesce(jsonb_agg(name order by name), '[]'::jsonb) from service_items where coalesce(name, '') <> '')
  ) into result;

  return result;
end;
$$;

drop function if exists public.dashboard_qbtime_rollups(text, text, date, date, text, text, text, text);
drop function if exists public.dashboard_qbtime_rollups(uuid, text, text, date, date, text, text, text, text);

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
  timesheets_raw as (
    select
      coalesce(r.source_hash, r.id::text) as unique_key,
      d.id as dataset_id,
      d.name as dataset_name,
      r.json_data,
      coalesce(public.safe_date(r.json_data->>'date'), public.safe_date(r.json_data->>'local_date'), public.safe_date(left(r.json_data->>'start', 10))) as work_date,
      coalesce(nullif(r.json_data #>> '{customfields,53105}', ''), nullif(r.json_data->>'service item', ''), nullif(r.json_data->>'service_item', '')) as service_item,
      coalesce(public.safe_numeric(r.json_data->>'duration'), public.safe_numeric(r.json_data->>'hours') * 3600, 0) as duration_seconds,
      coalesce(
        nullif(trim(concat(r.json_data->>'fname', ' ', r.json_data->>'lname')), ''),
        nullif(trim(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')), ''),
        nullif(r.json_data->>'username', ''),
        nullif(r.json_data->>'email', '')
      ) as uploaded_employee_name,
      nullif(r.json_data->>'jobcode_1', '') as uploaded_level1_name,
      nullif(r.json_data->>'jobcode_2', '') as uploaded_level2_name,
      nullif(r.json_data->>'jobcode_3', '') as uploaded_level3_name,
      coalesce(nullif(r.json_data->>'jobcode_3', ''), nullif(r.json_data->>'jobcode_2', ''), nullif(r.json_data->>'jobcode_1', ''), nullif(r.json_data->>'jobcode_id', '')) as uploaded_jobcode_name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where (
        d.name = 'QuickBooks Time Timesheets'
        or r.json_data ? 'hours'
        or r.json_data ? 'local_date'
        or r.json_data ? 'jobcode_1'
        or r.json_data ? 'service item'
      )
      and (dataset_uuid is null or d.id = dataset_uuid)
  ),
  timesheets as (
    select distinct on (unique_key) *
    from timesheets_raw
    order by unique_key
  ),
  filtered as (
    select
      t.*,
      e.employee_name,
      jp.jobcode_name,
      jp.level1_id,
      coalesce(jp.level1_name, t.uploaded_level1_name) as level1_name,
      jp.level2_id,
      coalesce(jp.level2_name, t.uploaded_level2_name) as level2_name,
      jp.level3_id,
      coalesce(jp.level3_name, t.uploaded_level3_name) as level3_name,
      coalesce(t.duration_seconds, 0) / 3600 as hours
    from timesheets t
    left join employees e on e.employee_id = t.json_data->>'user_id'
    left join job_paths jp on jp.jobcode_id = t.json_data->>'jobcode_id'
    where (coalesce(employee_filter, '') = '' or t.json_data->>'user_id' = employee_filter or coalesce(e.employee_name, t.uploaded_employee_name) ilike '%' || employee_filter || '%')
      and (start_date is null or t.work_date >= start_date)
      and (end_date is null or t.work_date <= end_date)
      and (coalesce(jobcode_level1_filter, '') = '' or jp.level1_id = jobcode_level1_filter or coalesce(jp.level1_name, t.uploaded_level1_name) ilike '%' || jobcode_level1_filter || '%')
      and (coalesce(jobcode_level2_filter, '') = '' or jp.level2_id = jobcode_level2_filter or coalesce(jp.level2_name, t.uploaded_level2_name) ilike '%' || jobcode_level2_filter || '%')
      and (coalesce(jobcode_level3_filter, '') = '' or jp.level3_id = jobcode_level3_filter or coalesce(jp.level3_name, t.uploaded_level3_name) ilike '%' || jobcode_level3_filter || '%')
      and (coalesce(service_item_filter, '') = '' or t.service_item ilike '%' || service_item_filter || '%')
      and (
        coalesce(keyword_filter, '') = ''
        or coalesce(e.employee_name, t.uploaded_employee_name) ilike '%' || keyword_filter || '%'
        or coalesce(jp.level1_name, t.uploaded_level1_name) ilike '%' || keyword_filter || '%'
        or coalesce(jp.level2_name, t.uploaded_level2_name) ilike '%' || keyword_filter || '%'
        or coalesce(jp.level3_name, t.uploaded_level3_name) ilike '%' || keyword_filter || '%'
        or coalesce(jp.jobcode_name, t.uploaded_jobcode_name) ilike '%' || keyword_filter || '%'
        or t.service_item ilike '%' || keyword_filter || '%'
        or t.json_data->>'notes' ilike '%' || keyword_filter || '%'
      )
  ),
  hours_by_employee as (
    select coalesce(jsonb_agg(jsonb_build_object('employee', employee, 'hours', round(hours::numeric, 2)) order by hours desc), '[]'::jsonb) as rows
    from (
      select coalesce(employee_name, uploaded_employee_name, json_data->>'user_id', 'Unassigned') as employee, sum(hours) as hours
      from filtered
      group by 1
      order by 2 desc
      limit 15
    ) s
  ),
  hours_by_jobcode as (
    select coalesce(jsonb_agg(jsonb_build_object('jobcode', jobcode, 'hours', round(hours::numeric, 2)) order by hours desc), '[]'::jsonb) as rows
    from (
      select coalesce(nullif(concat_ws(' / ', nullif(level1_name, ''), nullif(level2_name, ''), nullif(level3_name, '')), ''), jobcode_name, uploaded_jobcode_name, json_data->>'jobcode_id', 'Unassigned') as jobcode,
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
      select coalesce(employee_name, uploaded_employee_name, json_data->>'user_id', 'Unassigned') as employee,
        sum(hours) as hours,
        count(*)::int as timesheets,
        count(distinct coalesce(nullif(json_data->>'jobcode_id', ''), nullif(jobcode_name, ''), nullif(uploaded_jobcode_name, '')))::int as jobcodes,
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
        coalesce(employee_name, uploaded_employee_name, json_data->>'user_id', 'Unassigned') as employee,
        level1_name as jobcode_level1,
        level2_name as jobcode_level2,
        level3_name as jobcode_level3,
        coalesce(jobcode_name, uploaded_jobcode_name, json_data->>'jobcode_id', 'Unassigned') as jobcode,
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
    'filtered_employees', (select count(distinct coalesce(nullif(json_data->>'user_id', ''), nullif(employee_name, ''), nullif(uploaded_employee_name, ''))) from filtered),
    'filtered_jobcodes', (select count(distinct coalesce(nullif(json_data->>'jobcode_id', ''), nullif(jobcode_name, ''), nullif(uploaded_jobcode_name, ''))) from filtered),
    'filtered_service_items', (select count(distinct nullif(service_item, '')) from filtered),
    'date_start', (select min(work_date) from filtered),
    'date_end', (select max(work_date) from filtered)
  ) into result;

  return result;
end;
$$;

drop function if exists public.search_records_advanced(uuid, text, text, text, timestamptz, timestamptz, text, text, text, text, boolean, text, text, text, integer, integer);
drop function if exists public.search_records_advanced(uuid, text, text, text, timestamptz, timestamptz, text, text, text, text, text, boolean, text, text, text, integer, integer);

create or replace function public.search_records_advanced(
  dataset_uuid uuid default null,
  search_term text default null,
  exact_key text default null,
  exact_value text default null,
  start_date timestamptz default null,
  end_date timestamptz default null,
  user_filter text default null,
  employee_filter text default null,
  jobcode_filter text default null,
  service_item_filter text default null,
  status_filter text default null,
  pto_only boolean default false,
  customer_filter text default null,
  sort_field text default 'created_at',
  sort_direction text default 'desc',
  limit_count integer default 50,
  offset_count integer default 0
)
returns table(
  id uuid,
  dataset_id uuid,
  dataset_name text,
  json_data jsonb,
  created_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  lim integer := least(greatest(coalesce(limit_count, 50), 1), 250);
  off integer := greatest(coalesce(offset_count, 0), 0);
  sort_is_asc boolean := lower(coalesce(sort_direction, 'desc')) = 'asc';
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  return query
  with employees as (
    select (r.json_data->>'id')::text as employee_id,
      coalesce(nullif(trim(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')), ''), r.json_data->>'email', r.json_data->>'username', r.json_data->>'id') as employee_name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Employees'
      and public.can_access_dataset(r.dataset_id)
  ),
  jobcodes as (
    select
      (r.json_data->>'id')::text as jobcode_id,
      nullif(r.json_data->>'parent_id', '0') as parent_id,
      coalesce(r.json_data->>'name', r.json_data->>'short_code', r.json_data->>'id') as jobcode_name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Job Codes'
      and public.can_access_dataset(r.dataset_id)
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
  record_context as (
    select
      r.id,
      r.dataset_id,
      d.name as dataset_name,
      r.json_data - 'pto_balances' - 'time_off_type' - 'time_off_request_id' as clean_json_data,
      r.created_at,
      coalesce(r.source_hash, r.id::text) as unique_key,
      coalesce(public.safe_date(r.json_data->>'date'), public.safe_date(r.json_data->>'local_date'), public.safe_date(left(r.json_data->>'start', 10)), r.created_at::date) as record_date,
      coalesce(public.safe_numeric(r.json_data->>'duration'), public.safe_numeric(r.json_data->>'hours') * 3600) as duration_seconds,
      coalesce(
        e.employee_name,
        nullif(trim(concat(r.json_data->>'fname', ' ', r.json_data->>'lname')), ''),
        nullif(trim(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')), ''),
        nullif(r.json_data->>'username', ''),
        nullif(r.json_data->>'email', '')
      ) as employee_name,
      coalesce(jp.jobcode_name, nullif(r.json_data->>'jobcode_3', ''), nullif(r.json_data->>'jobcode_2', ''), nullif(r.json_data->>'jobcode_1', ''), nullif(r.json_data->>'name', ''), nullif(r.json_data->>'jobcode_id', '')) as jobcode_name,
      jp.level1_id,
      coalesce(jp.level1_name, nullif(r.json_data->>'jobcode_1', '')) as level1_name,
      jp.level2_id,
      coalesce(jp.level2_name, nullif(r.json_data->>'jobcode_2', '')) as level2_name,
      jp.level3_id,
      coalesce(jp.level3_name, nullif(r.json_data->>'jobcode_3', '')) as level3_name,
      coalesce(nullif(r.json_data #>> '{customfields,53105}', ''), nullif(r.json_data->>'service item', ''), nullif(r.json_data->>'service_item', '')) as service_item
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    left join employees e on e.employee_id = r.json_data->>'user_id'
    left join job_paths jp on jp.jobcode_id = r.json_data->>'jobcode_id'
    where public.can_access_dataset(r.dataset_id)
      and d.name <> 'QuickBooks Time PTO'
      and (dataset_uuid is null or r.dataset_id = dataset_uuid)
  ),
  enriched as (
    select
      id,
      dataset_id,
      dataset_name,
      created_at,
      unique_key,
      record_date,
      duration_seconds,
      employee_name,
      jobcode_name,
      level1_id,
      level1_name,
      level2_id,
      level2_name,
      level3_id,
      level3_name,
      service_item,
      clean_json_data ||
        jsonb_strip_nulls(jsonb_build_object(
          'employee_name', employee_name,
          'jobcode_name', jobcode_name,
          'jobcode_level1', level1_name,
          'jobcode_level2', level2_name,
          'jobcode_level3', level3_name,
          'service_item', service_item,
          'hours', case when duration_seconds is null then null else round((duration_seconds / 3600)::numeric, 2) end,
          'work_date', record_date
        )) as json_data
    from record_context
  ),
  filtered_raw as (
    select
      id,
      dataset_id,
      dataset_name,
      json_data,
      created_at,
      unique_key
    from enriched
    where (coalesce(search_term, '') = '' or json_data::text ilike '%' || search_term || '%' or dataset_name ilike '%' || search_term || '%')
      and (coalesce(exact_key, '') = '' or coalesce(json_data->>exact_key, '') = coalesce(exact_value, ''))
      and (start_date is null or created_at >= start_date or record_date >= start_date::date)
      and (end_date is null or created_at <= end_date or record_date <= end_date::date)
      and (coalesce(user_filter, '') = '' or json_data->>'user_id' = user_filter or json_data->>'created_by_user_id' = user_filter or json_data->>'username' ilike '%' || user_filter || '%' or json_data->>'email' ilike '%' || user_filter || '%')
      and (coalesce(employee_filter, '') = '' or json_data->>'user_id' = employee_filter or employee_name ilike '%' || employee_filter || '%' or concat_ws(' ', json_data->>'first_name', json_data->>'last_name') ilike '%' || employee_filter || '%' or json_data->>'employee_number' = employee_filter)
      and (coalesce(jobcode_filter, '') = '' or json_data->>'jobcode_id' = jobcode_filter or json_data->>'name' ilike '%' || jobcode_filter || '%' or json_data->>'short_code' ilike '%' || jobcode_filter || '%' or jobcode_name ilike '%' || jobcode_filter || '%' or level1_name ilike '%' || jobcode_filter || '%' or level2_name ilike '%' || jobcode_filter || '%' or level3_name ilike '%' || jobcode_filter || '%')
      and (coalesce(service_item_filter, '') = '' or service_item ilike '%' || service_item_filter || '%' or json_data->>'service_item' ilike '%' || service_item_filter || '%')
      and (coalesce(status_filter, '') = '' or lower(coalesce(json_data->>'status', json_data->>'state', json_data->>'active', '')) = lower(status_filter))
      and (coalesce(customer_filter, '') = '' or json_data->>'client_id' = customer_filter or json_data->>'project_id' = customer_filter or json_data->>'client' ilike '%' || customer_filter || '%' or json_data->>'company_name' ilike '%' || customer_filter || '%' or json_data->>'customer' ilike '%' || customer_filter || '%' or json_data->>'name' ilike '%' || customer_filter || '%' or jobcode_name ilike '%' || customer_filter || '%' or level1_name ilike '%' || customer_filter || '%' or level2_name ilike '%' || customer_filter || '%' or level3_name ilike '%' || customer_filter || '%')
  ),
  deduped as (
    select distinct on (unique_key) *
    from filtered_raw
    order by unique_key, created_at desc
  ),
  counted as (
    select deduped.*, count(*) over() as total_count
    from deduped
  )
  select counted.id, counted.dataset_id, counted.dataset_name, counted.json_data, counted.created_at, counted.total_count
  from counted
  order by
    case when sort_field = 'dataset' and sort_is_asc then counted.dataset_name end asc,
    case when sort_field = 'dataset' and not sort_is_asc then counted.dataset_name end desc,
    case when sort_field = 'created_at' and sort_is_asc then counted.created_at end asc,
    case when sort_field = 'created_at' and not sort_is_asc then counted.created_at end desc,
    counted.created_at desc
  limit lim
  offset off;
end;
$$;

create or replace function public.search_records_summary(
  dataset_uuid uuid default null,
  search_term text default null,
  exact_key text default null,
  exact_value text default null,
  start_date timestamptz default null,
  end_date timestamptz default null,
  user_filter text default null,
  employee_filter text default null,
  jobcode_filter text default null,
  service_item_filter text default null,
  status_filter text default null,
  pto_only boolean default false,
  customer_filter text default null,
  sort_field text default 'created_at',
  sort_direction text default 'desc'
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
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  with employees as (
    select (r.json_data->>'id')::text as employee_id,
      coalesce(nullif(trim(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')), ''), r.json_data->>'email', r.json_data->>'username', r.json_data->>'id') as employee_name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Employees'
      and public.can_access_dataset(r.dataset_id)
  ),
  jobcodes as (
    select
      (r.json_data->>'id')::text as jobcode_id,
      nullif(r.json_data->>'parent_id', '0') as parent_id,
      coalesce(r.json_data->>'name', r.json_data->>'short_code', r.json_data->>'id') as jobcode_name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Job Codes'
      and public.can_access_dataset(r.dataset_id)
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
  record_context as (
    select
      r.id,
      r.dataset_id,
      d.name as dataset_name,
      r.json_data - 'pto_balances' - 'time_off_type' - 'time_off_request_id' as clean_json_data,
      r.created_at,
      coalesce(r.source_hash, r.id::text) as unique_key,
      coalesce(public.safe_date(r.json_data->>'date'), public.safe_date(r.json_data->>'local_date'), public.safe_date(left(r.json_data->>'start', 10)), r.created_at::date) as record_date,
      coalesce(public.safe_numeric(r.json_data->>'duration'), public.safe_numeric(r.json_data->>'hours') * 3600) as duration_seconds,
      coalesce(
        e.employee_name,
        nullif(trim(concat(r.json_data->>'fname', ' ', r.json_data->>'lname')), ''),
        nullif(trim(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')), ''),
        nullif(r.json_data->>'username', ''),
        nullif(r.json_data->>'email', '')
      ) as employee_name,
      coalesce(jp.jobcode_name, nullif(r.json_data->>'jobcode_3', ''), nullif(r.json_data->>'jobcode_2', ''), nullif(r.json_data->>'jobcode_1', ''), nullif(r.json_data->>'name', ''), nullif(r.json_data->>'jobcode_id', '')) as jobcode_name,
      jp.level1_id,
      coalesce(jp.level1_name, nullif(r.json_data->>'jobcode_1', '')) as level1_name,
      jp.level2_id,
      coalesce(jp.level2_name, nullif(r.json_data->>'jobcode_2', '')) as level2_name,
      jp.level3_id,
      coalesce(jp.level3_name, nullif(r.json_data->>'jobcode_3', '')) as level3_name,
      coalesce(nullif(r.json_data #>> '{customfields,53105}', ''), nullif(r.json_data->>'service item', ''), nullif(r.json_data->>'service_item', '')) as service_item
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    left join employees e on e.employee_id = r.json_data->>'user_id'
    left join job_paths jp on jp.jobcode_id = r.json_data->>'jobcode_id'
    where public.can_access_dataset(r.dataset_id)
      and d.name <> 'QuickBooks Time PTO'
      and (dataset_uuid is null or r.dataset_id = dataset_uuid)
  ),
  enriched as (
    select
      id,
      dataset_id,
      dataset_name,
      created_at,
      unique_key,
      record_date,
      duration_seconds,
      employee_name,
      jobcode_name,
      level1_id,
      level1_name,
      level2_id,
      level2_name,
      level3_id,
      level3_name,
      service_item,
      clean_json_data ||
        jsonb_strip_nulls(jsonb_build_object(
          'employee_name', employee_name,
          'jobcode_name', jobcode_name,
          'jobcode_level1', level1_name,
          'jobcode_level2', level2_name,
          'jobcode_level3', level3_name,
          'service_item', service_item,
          'hours', case when duration_seconds is null then null else round((duration_seconds / 3600)::numeric, 2) end,
          'work_date', record_date
        )) as json_data
    from record_context
  ),
  filtered_raw as (
    select
      id,
      dataset_id,
      dataset_name,
      json_data,
      created_at,
      unique_key,
      record_date,
      duration_seconds,
      employee_name,
      jobcode_name,
      level1_name,
      level2_name,
      level3_name,
      service_item
    from enriched
    where (coalesce(search_term, '') = '' or json_data::text ilike '%' || search_term || '%' or dataset_name ilike '%' || search_term || '%')
      and (coalesce(exact_key, '') = '' or coalesce(json_data->>exact_key, '') = coalesce(exact_value, ''))
      and (start_date is null or created_at >= start_date or record_date >= start_date::date)
      and (end_date is null or created_at <= end_date or record_date <= end_date::date)
      and (coalesce(user_filter, '') = '' or json_data->>'user_id' = user_filter or json_data->>'created_by_user_id' = user_filter or json_data->>'username' ilike '%' || user_filter || '%' or json_data->>'email' ilike '%' || user_filter || '%')
      and (coalesce(employee_filter, '') = '' or json_data->>'user_id' = employee_filter or employee_name ilike '%' || employee_filter || '%' or concat_ws(' ', json_data->>'first_name', json_data->>'last_name') ilike '%' || employee_filter || '%' or json_data->>'employee_number' = employee_filter)
      and (coalesce(jobcode_filter, '') = '' or json_data->>'jobcode_id' = jobcode_filter or json_data->>'name' ilike '%' || jobcode_filter || '%' or json_data->>'short_code' ilike '%' || jobcode_filter || '%' or jobcode_name ilike '%' || jobcode_filter || '%' or level1_name ilike '%' || jobcode_filter || '%' or level2_name ilike '%' || jobcode_filter || '%' or level3_name ilike '%' || jobcode_filter || '%')
      and (coalesce(service_item_filter, '') = '' or service_item ilike '%' || service_item_filter || '%' or json_data->>'service_item' ilike '%' || service_item_filter || '%')
      and (coalesce(status_filter, '') = '' or lower(coalesce(json_data->>'status', json_data->>'state', json_data->>'active', '')) = lower(status_filter))
      and (coalesce(customer_filter, '') = '' or json_data->>'client_id' = customer_filter or json_data->>'project_id' = customer_filter or json_data->>'client' ilike '%' || customer_filter || '%' or json_data->>'company_name' ilike '%' || customer_filter || '%' or json_data->>'customer' ilike '%' || customer_filter || '%' or json_data->>'name' ilike '%' || customer_filter || '%' or jobcode_name ilike '%' || customer_filter || '%' or level1_name ilike '%' || customer_filter || '%' or level2_name ilike '%' || customer_filter || '%' or level3_name ilike '%' || customer_filter || '%')
  ),
  deduped as (
    select distinct on (unique_key) *
    from filtered_raw
    order by unique_key, created_at desc
  ),
  dataset_rows as (
    select coalesce(jsonb_agg(jsonb_build_object('id', dataset_id, 'name', dataset_name, 'records', records) order by records desc, dataset_name), '[]'::jsonb) as rows
    from (
      select dataset_id, dataset_name, count(*)::int as records
      from deduped
      group by dataset_id, dataset_name
      order by 3 desc
      limit 12
    ) s
  ),
  day_rows as (
    select coalesce(jsonb_agg(jsonb_build_object('date', record_date, 'records', records) order by record_date), '[]'::jsonb) as rows
    from (
      select record_date, count(*)::int as records
      from deduped
      where record_date is not null
      group by record_date
      order by record_date
    ) s
  )
  select jsonb_build_object(
    'dataset_name', (select name from public.datasets where id = dataset_uuid),
    'raw_records', (select count(*) from filtered_raw),
    'unique_records', (select count(*) from deduped),
    'duplicates_removed', (select greatest((select count(*) from filtered_raw) - (select count(*) from deduped), 0)),
    'dataset_count', (select count(distinct dataset_id) from deduped),
    'employee_count', (select count(distinct coalesce(nullif(employee_name, ''), nullif(json_data->>'user_id', ''), nullif(json_data->>'employee_number', ''), nullif(json_data->>'email', ''))) from deduped),
    'jobcode_count', (select count(distinct coalesce(nullif(json_data->>'jobcode_id', ''), nullif(jobcode_name, ''), nullif(json_data->>'name', ''), nullif(json_data->>'short_code', ''))) from deduped),
    'service_item_count', (select count(distinct nullif(service_item, '')) from deduped),
    'hours', (select coalesce(round((sum(coalesce(duration_seconds, 0)) / 3600)::numeric, 2), 0) from deduped),
    'date_start', (select min(record_date) from deduped),
    'date_end', (select max(record_date) from deduped),
    'records_by_dataset', (select rows from dataset_rows),
    'records_by_day', (select rows from day_rows)
  ) into result;

  return result;
end;
$$;

revoke all on function public.dashboard_qbtime_rollups(uuid, text, text, date, date, text, text, text, text) from public;
grant execute on function public.dashboard_qbtime_rollups(uuid, text, text, date, date, text, text, text, text) to authenticated;

revoke all on function public.dashboard_qbtime_filter_options() from public;
grant execute on function public.dashboard_qbtime_filter_options() to authenticated;

revoke all on function public.search_records_advanced(uuid, text, text, text, timestamptz, timestamptz, text, text, text, text, text, boolean, text, text, text, integer, integer) from public;
grant execute on function public.search_records_advanced(uuid, text, text, text, timestamptz, timestamptz, text, text, text, text, text, boolean, text, text, text, integer, integer) to authenticated;

revoke all on function public.search_records_summary(uuid, text, text, text, timestamptz, timestamptz, text, text, text, text, text, boolean, text, text, text) from public;
grant execute on function public.search_records_summary(uuid, text, text, text, timestamptz, timestamptz, text, text, text, text, text, boolean, text, text, text) to authenticated;
