create or replace function public.matches_employee_name(
  employee_name text,
  employee_id text,
  query text
)
returns boolean
language sql
stable
as $$
  select coalesce(trim(query), '') = ''
    or lower(coalesce(employee_id, '')) = lower(trim(query))
    or lower(coalesce(employee_name, '')) like '%' || lower(trim(query)) || '%'
    or not exists (
      select 1
      from regexp_split_to_table(lower(trim(query)), '\s+') token
      where token <> ''
        and lower(coalesce(employee_name, '')) not like '%' || token || '%'
    );
$$;

revoke all on function public.matches_employee_name(text, text, text) from public;
grant execute on function public.matches_employee_name(text, text, text) to authenticated;

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
      and (dataset_uuid is null or d.id = dataset_uuid)
  ),
  scoped as materialized (
    select r.*
    from public.dashboard_experience_rollups r
    join allowed_datasets d on d.id = r.dataset_id
    where (start_date is null or r.work_date >= start_date)
      and (end_date is null or r.work_date <= end_date)
      and public.matches_employee_name(r.employee, r.employee_id, employee_filter)
      and (coalesce(jobcode_level1_filter, '') = '' or r.jobcode_level1 ilike '%' || jobcode_level1_filter || '%' or r.jobcode ilike '%' || jobcode_level1_filter || '%')
      and (coalesce(jobcode_level2_filter, '') = '' or r.jobcode_level2 ilike '%' || jobcode_level2_filter || '%' or r.jobcode ilike '%' || jobcode_level2_filter || '%')
      and (coalesce(jobcode_level3_filter, '') = '' or r.jobcode_level3 ilike '%' || jobcode_level3_filter || '%' or r.jobcode ilike '%' || jobcode_level3_filter || '%')
      and (coalesce(service_item_filter, '') = '' or r.service_item ilike '%' || service_item_filter || '%')
      and (
        keyword = ''
        or r.search_text ilike '%' || keyword || '%'
        or public.matches_employee_name(r.employee, r.employee_id, keyword_filter)
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
  from totals;

  return result;
end;
$$;

create or replace function public.experience_search_records(
  dataset_uuid uuid default null,
  search_term text default null,
  exact_key text default null,
  exact_value text default null,
  p_start_date date default null,
  p_end_date date default null,
  user_filter text default null,
  employee_filter text default null,
  jobcode_filter text default null,
  service_item_filter text default null,
  status_filter text default null,
  customer_filter text default null,
  sort_field text default 'created_at',
  sort_direction text default 'desc',
  limit_count integer default 50,
  offset_count integer default 0
)
returns table(id uuid, dataset_id uuid, dataset_name text, json_data jsonb, created_at timestamptz, total_count bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  lim integer := least(greatest(coalesce(limit_count, 50), 1), 250);
  off integer := greatest(coalesce(offset_count, 0), 0);
  term text := lower(coalesce(search_term, ''));
  sort_is_asc boolean := lower(coalesce(sort_direction, 'desc')) = 'asc';
  auth_user_id uuid := auth.uid();
  is_admin_user boolean := public.is_admin();
begin
  if auth_user_id is null then
    raise exception 'Authentication required';
  end if;

  return query
  with allowed_datasets as (
    select d.id
    from public.datasets d
    where d.name <> 'QuickBooks Time PTO'
      and (is_admin_user or exists (
        select 1 from public.dataset_permissions dp
        where dp.dataset_id = d.id and dp.user_id = auth_user_id
      ))
      and (dataset_uuid is null or d.id = dataset_uuid)
  ),
  filtered as materialized (
    select e.*,
      e.json_data ||
        jsonb_strip_nulls(jsonb_build_object(
          'employee_name', e.employee,
          'user_id', e.employee_id,
          'jobcode_name', e.jobcode,
          'jobcode_1', e.jobcode_level1,
          'jobcode_2', e.jobcode_level2,
          'jobcode_3', e.jobcode_level3,
          'service_item', e.service_item,
          'hours', round(e.hours::numeric, 2),
          'work_date', e.work_date
        )) as record_json_data
    from public.dashboard_experience_unique_records e
    join allowed_datasets d on d.id = e.dataset_id
    where (p_start_date is null or e.work_date >= p_start_date)
      and (p_end_date is null or e.work_date <= p_end_date)
      and (term = '' or e.search_text ilike '%' || term || '%' or lower(e.dataset_name) ilike '%' || term || '%' or public.matches_employee_name(e.employee, e.employee_id, search_term) or lower(e.jobcode) ilike '%' || term || '%' or lower(e.service_item) ilike '%' || term || '%')
      and (coalesce(exact_key, '') = '' or coalesce(e.json_data->>exact_key, '') = coalesce(exact_value, '') or coalesce((jsonb_build_object('employee_name', e.employee, 'user_id', e.employee_id, 'jobcode_name', e.jobcode, 'jobcode_1', e.jobcode_level1, 'jobcode_2', e.jobcode_level2, 'jobcode_3', e.jobcode_level3, 'service_item', e.service_item, 'hours', round(e.hours::numeric, 2)::text, 'work_date', e.work_date::text)->>exact_key), '') = coalesce(exact_value, ''))
      and (coalesce(user_filter, '') = '' or public.matches_employee_name(e.employee, e.employee_id, user_filter) or e.json_data->>'username' ilike '%' || user_filter || '%' or e.json_data->>'email' ilike '%' || user_filter || '%')
      and public.matches_employee_name(e.employee, e.employee_id, employee_filter)
      and (coalesce(jobcode_filter, '') = '' or e.jobcode ilike '%' || jobcode_filter || '%' or e.jobcode_level1 ilike '%' || jobcode_filter || '%' or e.jobcode_level2 ilike '%' || jobcode_filter || '%' or e.jobcode_level3 ilike '%' || jobcode_filter || '%' or e.json_data->>'jobcode_id' = jobcode_filter)
      and (coalesce(service_item_filter, '') = '' or e.service_item ilike '%' || service_item_filter || '%')
      and (coalesce(status_filter, '') = '' or lower(coalesce(e.json_data->>'status', e.json_data->>'state', e.json_data->>'active', '')) = lower(status_filter))
      and (coalesce(customer_filter, '') = '' or e.search_text ilike '%' || customer_filter || '%' or e.jobcode ilike '%' || customer_filter || '%' or e.service_item ilike '%' || customer_filter || '%')
  ),
  counted as (
    select f.*, count(*) over() as result_total_count
    from filtered f
  )
  select c.record_id, c.dataset_id, c.dataset_name, c.record_json_data, c.work_date::timestamptz, c.result_total_count
  from counted c
  order by
    case when sort_field = 'dataset' and sort_is_asc then c.dataset_name end asc,
    case when sort_field = 'dataset' and not sort_is_asc then c.dataset_name end desc,
    case when sort_field = 'created_at' and sort_is_asc then c.work_date end asc,
    case when sort_field = 'created_at' and not sort_is_asc then c.work_date end desc,
    c.work_date desc,
    c.employee asc
  limit lim
  offset off;
end;
$$;

create or replace function public.experience_search_summary(
  dataset_uuid uuid default null,
  search_term text default null,
  exact_key text default null,
  exact_value text default null,
  p_start_date date default null,
  p_end_date date default null,
  user_filter text default null,
  employee_filter text default null,
  jobcode_filter text default null,
  service_item_filter text default null,
  status_filter text default null,
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
  term text := lower(coalesce(search_term, ''));
  auth_user_id uuid := auth.uid();
  is_admin_user boolean := public.is_admin();
begin
  if auth_user_id is null then
    raise exception 'Authentication required';
  end if;

  with allowed_datasets as (
    select d.id
    from public.datasets d
    where d.name <> 'QuickBooks Time PTO'
      and (is_admin_user or exists (
        select 1 from public.dataset_permissions dp
        where dp.dataset_id = d.id and dp.user_id = auth_user_id
      ))
      and (dataset_uuid is null or d.id = dataset_uuid)
  ),
  filtered as materialized (
    select e.*
    from public.dashboard_experience_unique_records e
    join allowed_datasets d on d.id = e.dataset_id
    where (p_start_date is null or e.work_date >= p_start_date)
      and (p_end_date is null or e.work_date <= p_end_date)
      and (term = '' or e.search_text ilike '%' || term || '%' or lower(e.dataset_name) ilike '%' || term || '%' or public.matches_employee_name(e.employee, e.employee_id, search_term) or lower(e.jobcode) ilike '%' || term || '%' or lower(e.service_item) ilike '%' || term || '%')
      and (coalesce(exact_key, '') = '' or coalesce(e.json_data->>exact_key, '') = coalesce(exact_value, '') or coalesce((jsonb_build_object('employee_name', e.employee, 'user_id', e.employee_id, 'jobcode_name', e.jobcode, 'jobcode_1', e.jobcode_level1, 'jobcode_2', e.jobcode_level2, 'jobcode_3', e.jobcode_level3, 'service_item', e.service_item, 'hours', round(e.hours::numeric, 2)::text, 'work_date', e.work_date::text)->>exact_key), '') = coalesce(exact_value, ''))
      and (coalesce(user_filter, '') = '' or public.matches_employee_name(e.employee, e.employee_id, user_filter) or e.json_data->>'username' ilike '%' || user_filter || '%' or e.json_data->>'email' ilike '%' || user_filter || '%')
      and public.matches_employee_name(e.employee, e.employee_id, employee_filter)
      and (coalesce(jobcode_filter, '') = '' or e.jobcode ilike '%' || jobcode_filter || '%' or e.jobcode_level1 ilike '%' || jobcode_filter || '%' or e.jobcode_level2 ilike '%' || jobcode_filter || '%' or e.jobcode_level3 ilike '%' || jobcode_filter || '%' or e.json_data->>'jobcode_id' = jobcode_filter)
      and (coalesce(service_item_filter, '') = '' or e.service_item ilike '%' || service_item_filter || '%')
      and (coalesce(status_filter, '') = '' or lower(coalesce(e.json_data->>'status', e.json_data->>'state', e.json_data->>'active', '')) = lower(status_filter))
      and (coalesce(customer_filter, '') = '' or e.search_text ilike '%' || customer_filter || '%' or e.jobcode ilike '%' || customer_filter || '%' or e.service_item ilike '%' || customer_filter || '%')
  ),
  dataset_rows as (
    select coalesce(jsonb_agg(jsonb_build_object('id', s.dataset_id, 'name', s.dataset_name, 'records', s.records) order by s.records desc, s.dataset_name), '[]'::jsonb) as rows
    from (
      select dataset_id, dataset_name, count(*)::int as records
      from filtered
      group by dataset_id, dataset_name
      order by 3 desc
      limit 12
    ) s
  ),
  day_rows as (
    select coalesce(jsonb_agg(jsonb_build_object('date', s.work_date, 'records', s.records) order by s.work_date), '[]'::jsonb) as rows
    from (
      select work_date, count(*)::int as records
      from filtered
      where work_date is not null
      group by work_date
      order by work_date
    ) s
  )
  select jsonb_build_object(
    'dataset_name', (select ds.name from public.datasets ds where ds.id = dataset_uuid),
    'raw_records', (select count(*) from filtered),
    'unique_records', (select count(*) from filtered),
    'duplicates_removed', 0,
    'dataset_count', (select count(distinct dataset_id) from filtered),
    'employee_count', (select count(distinct nullif(employee, 'Unassigned')) from filtered),
    'jobcode_count', (select count(distinct nullif(jobcode, 'Unassigned')) from filtered),
    'service_item_count', (select count(distinct nullif(service_item, 'No service item')) from filtered),
    'hours', (select coalesce(round(sum(hours)::numeric, 2), 0) from filtered),
    'date_start', (select min(work_date) from filtered),
    'date_end', (select max(work_date) from filtered),
    'records_by_dataset', (select rows from dataset_rows),
    'records_by_day', (select rows from day_rows)
  ) into result;

  return result;
end;
$$;

revoke all on function public.dashboard_qbtime_rollups(uuid, text, text, date, date, text, text, text, text) from public;
revoke all on function public.experience_search_records(uuid, text, text, text, date, date, text, text, text, text, text, text, text, text, integer, integer) from public;
revoke all on function public.experience_search_summary(uuid, text, text, text, date, date, text, text, text, text, text, text, text, text) from public;
grant execute on function public.dashboard_qbtime_rollups(uuid, text, text, date, date, text, text, text, text) to authenticated;
grant execute on function public.experience_search_records(uuid, text, text, text, date, date, text, text, text, text, text, text, text, text, integer, integer) to authenticated;
grant execute on function public.experience_search_summary(uuid, text, text, text, date, date, text, text, text, text, text, text, text, text) to authenticated;
