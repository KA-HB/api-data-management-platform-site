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
  term text := lower(coalesce(search_term, ''));
  from_date date := start_date::date;
  through_date date := end_date::date;
  auth_user_id uuid := auth.uid();
  is_admin_user boolean := public.is_admin();
begin
  if auth_user_id is null then
    raise exception 'Authentication required';
  end if;

  return query
  with allowed_datasets as (
    select d.id, d.name
    from public.datasets d
    where d.name <> 'QuickBooks Time PTO'
      and (is_admin_user or exists (
        select 1 from public.dataset_permissions dp
        where dp.dataset_id = d.id and dp.user_id = auth_user_id
      ))
      and (dataset_uuid is null or d.id = dataset_uuid)
  ),
  filtered as materialized (
    select
      e.record_id,
      e.dataset_id,
      e.dataset_name,
      e.work_date,
      e.employee,
      e.employee_id,
      e.jobcode,
      e.jobcode_level1,
      e.jobcode_level2,
      e.jobcode_level3,
      e.service_item,
      e.hours,
      e.search_text,
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
    where coalesce(pto_only, false) = false
      and (from_date is null or e.work_date >= from_date)
      and (through_date is null or e.work_date <= through_date)
      and (term = '' or e.search_text ilike '%' || term || '%' or lower(e.dataset_name) ilike '%' || term || '%' or lower(e.employee) ilike '%' || term || '%' or lower(e.jobcode) ilike '%' || term || '%' or lower(e.service_item) ilike '%' || term || '%')
      and (coalesce(exact_key, '') = '' or coalesce(e.json_data->>exact_key, '') = coalesce(exact_value, '') or coalesce((jsonb_build_object('employee_name', e.employee, 'user_id', e.employee_id, 'jobcode_name', e.jobcode, 'jobcode_1', e.jobcode_level1, 'jobcode_2', e.jobcode_level2, 'jobcode_3', e.jobcode_level3, 'service_item', e.service_item, 'hours', round(e.hours::numeric, 2)::text, 'work_date', e.work_date::text)->>exact_key), '') = coalesce(exact_value, ''))
      and (coalesce(user_filter, '') = '' or e.employee_id = user_filter or e.employee ilike '%' || user_filter || '%' or e.json_data->>'username' ilike '%' || user_filter || '%' or e.json_data->>'email' ilike '%' || user_filter || '%')
      and (coalesce(employee_filter, '') = '' or e.employee_id = employee_filter or e.employee ilike '%' || employee_filter || '%')
      and (coalesce(jobcode_filter, '') = '' or e.jobcode ilike '%' || jobcode_filter || '%' or e.jobcode_level1 ilike '%' || jobcode_filter || '%' or e.jobcode_level2 ilike '%' || jobcode_filter || '%' or e.jobcode_level3 ilike '%' || jobcode_filter || '%' or e.json_data->>'jobcode_id' = jobcode_filter)
      and (coalesce(service_item_filter, '') = '' or e.service_item ilike '%' || service_item_filter || '%')
      and (coalesce(status_filter, '') = '' or lower(coalesce(e.json_data->>'status', e.json_data->>'state', e.json_data->>'active', '')) = lower(status_filter))
      and (coalesce(customer_filter, '') = '' or e.search_text ilike '%' || customer_filter || '%' or e.jobcode ilike '%' || customer_filter || '%' or e.service_item ilike '%' || customer_filter || '%')
  ),
  counted as (
    select f.*, count(*) over() as result_total_count
    from filtered f
  )
  select
    c.record_id,
    c.dataset_id,
    c.dataset_name,
    c.record_json_data,
    c.work_date::timestamptz,
    c.result_total_count
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
  term text := lower(coalesce(search_term, ''));
  from_date date := start_date::date;
  through_date date := end_date::date;
  auth_user_id uuid := auth.uid();
  is_admin_user boolean := public.is_admin();
begin
  if auth_user_id is null then
    raise exception 'Authentication required';
  end if;

  with allowed_datasets as (
    select d.id, d.name
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
    where coalesce(pto_only, false) = false
      and (from_date is null or e.work_date >= from_date)
      and (through_date is null or e.work_date <= through_date)
      and (term = '' or e.search_text ilike '%' || term || '%' or lower(e.dataset_name) ilike '%' || term || '%' or lower(e.employee) ilike '%' || term || '%' or lower(e.jobcode) ilike '%' || term || '%' or lower(e.service_item) ilike '%' || term || '%')
      and (coalesce(exact_key, '') = '' or coalesce(e.json_data->>exact_key, '') = coalesce(exact_value, '') or coalesce((jsonb_build_object('employee_name', e.employee, 'user_id', e.employee_id, 'jobcode_name', e.jobcode, 'jobcode_1', e.jobcode_level1, 'jobcode_2', e.jobcode_level2, 'jobcode_3', e.jobcode_level3, 'service_item', e.service_item, 'hours', round(e.hours::numeric, 2)::text, 'work_date', e.work_date::text)->>exact_key), '') = coalesce(exact_value, ''))
      and (coalesce(user_filter, '') = '' or e.employee_id = user_filter or e.employee ilike '%' || user_filter || '%' or e.json_data->>'username' ilike '%' || user_filter || '%' or e.json_data->>'email' ilike '%' || user_filter || '%')
      and (coalesce(employee_filter, '') = '' or e.employee_id = employee_filter or e.employee ilike '%' || employee_filter || '%')
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

revoke all on function public.search_records_advanced(uuid, text, text, text, timestamptz, timestamptz, text, text, text, text, text, boolean, text, text, text, integer, integer) from public;
grant execute on function public.search_records_advanced(uuid, text, text, text, timestamptz, timestamptz, text, text, text, text, text, boolean, text, text, text, integer, integer) to authenticated;

revoke all on function public.search_records_summary(uuid, text, text, text, timestamptz, timestamptz, text, text, text, text, text, boolean, text, text, text) from public;
grant execute on function public.search_records_summary(uuid, text, text, text, timestamptz, timestamptz, text, text, text, text, text, boolean, text, text, text) to authenticated;
