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
    select
      (r.json_data->>'id')::text as employee_id,
      coalesce(nullif(trim(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')), ''), r.json_data->>'email', r.json_data->>'username', r.json_data->>'id') as employee_name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Employees'
      and public.can_access_dataset(r.dataset_id)
  ),
  records_scope as (
    select
      r.id as record_id,
      r.dataset_id as record_dataset_id,
      d.name as record_dataset_name,
      r.json_data - 'pto_balances' - 'time_off_type' - 'time_off_request_id' as clean_json_data,
      r.created_at as record_created_at,
      coalesce(r.source_hash, r.id::text) as unique_key,
      coalesce(public.safe_date(r.json_data->>'date'), public.safe_date(r.json_data->>'local_date'), public.safe_date(left(r.json_data->>'start', 10)), r.created_at::date) as record_date,
      coalesce(public.safe_numeric(r.json_data->>'duration'), public.safe_numeric(r.json_data->>'hours') * 3600) as duration_seconds,
      coalesce(
        e.employee_name,
        nullif(trim(concat(r.json_data->>'fname', ' ', r.json_data->>'lname')), ''),
        nullif(trim(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')), ''),
        nullif(r.json_data->>'employee_name', ''),
        nullif(r.json_data->>'username', ''),
        nullif(r.json_data->>'email', '')
      ) as employee_name,
      coalesce(nullif(r.json_data->>'jobcode_3', ''), nullif(r.json_data->>'jobcode_2', ''), nullif(r.json_data->>'jobcode_1', ''), nullif(r.json_data->>'jobcode_name', ''), nullif(r.json_data->>'name', ''), nullif(r.json_data->>'short_code', ''), nullif(r.json_data->>'jobcode_id', '')) as jobcode_name,
      coalesce(nullif(r.json_data #>> '{customfields,53105}', ''), nullif(r.json_data->>'service item', ''), nullif(r.json_data->>'service_item', '')) as service_item
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    left join employees e on e.employee_id = r.json_data->>'user_id'
    where public.can_access_dataset(r.dataset_id)
      and d.name <> 'QuickBooks Time PTO'
      and (dataset_uuid is null or r.dataset_id = dataset_uuid)
  ),
  filtered_raw as (
    select
      rs.record_id,
      rs.record_dataset_id,
      rs.record_dataset_name,
      rs.record_created_at,
      rs.unique_key,
      rs.clean_json_data ||
        jsonb_strip_nulls(jsonb_build_object(
          'employee_name', rs.employee_name,
          'jobcode_name', rs.jobcode_name,
          'service_item', rs.service_item,
          'hours', case when rs.duration_seconds is null then null else round((rs.duration_seconds / 3600)::numeric, 2) end,
          'work_date', rs.record_date
        )) as record_json_data
    from records_scope rs
    where (coalesce(search_term, '') = '' or rs.clean_json_data::text ilike '%' || search_term || '%' or rs.record_dataset_name ilike '%' || search_term || '%' or rs.employee_name ilike '%' || search_term || '%' or rs.jobcode_name ilike '%' || search_term || '%' or rs.service_item ilike '%' || search_term || '%')
      and (coalesce(exact_key, '') = '' or coalesce(rs.clean_json_data->>exact_key, '') = coalesce(exact_value, ''))
      and (start_date is null or rs.record_created_at >= start_date or rs.record_date >= start_date::date)
      and (end_date is null or rs.record_created_at <= end_date or rs.record_date <= end_date::date)
      and (coalesce(user_filter, '') = '' or rs.clean_json_data->>'user_id' = user_filter or rs.clean_json_data->>'created_by_user_id' = user_filter or rs.clean_json_data->>'username' ilike '%' || user_filter || '%' or rs.clean_json_data->>'email' ilike '%' || user_filter || '%')
      and (coalesce(employee_filter, '') = '' or rs.clean_json_data->>'user_id' = employee_filter or rs.employee_name ilike '%' || employee_filter || '%' or concat_ws(' ', rs.clean_json_data->>'first_name', rs.clean_json_data->>'last_name') ilike '%' || employee_filter || '%' or concat_ws(' ', rs.clean_json_data->>'fname', rs.clean_json_data->>'lname') ilike '%' || employee_filter || '%' or rs.clean_json_data->>'employee_number' = employee_filter)
      and (coalesce(jobcode_filter, '') = '' or rs.clean_json_data->>'jobcode_id' = jobcode_filter or rs.clean_json_data->>'name' ilike '%' || jobcode_filter || '%' or rs.clean_json_data->>'short_code' ilike '%' || jobcode_filter || '%' or rs.clean_json_data->>'jobcode_1' ilike '%' || jobcode_filter || '%' or rs.clean_json_data->>'jobcode_2' ilike '%' || jobcode_filter || '%' or rs.clean_json_data->>'jobcode_3' ilike '%' || jobcode_filter || '%' or rs.jobcode_name ilike '%' || jobcode_filter || '%')
      and (coalesce(service_item_filter, '') = '' or rs.service_item ilike '%' || service_item_filter || '%' or rs.clean_json_data->>'service_item' ilike '%' || service_item_filter || '%')
      and (coalesce(status_filter, '') = '' or lower(coalesce(rs.clean_json_data->>'status', rs.clean_json_data->>'state', rs.clean_json_data->>'active', '')) = lower(status_filter))
      and (coalesce(customer_filter, '') = '' or rs.clean_json_data->>'client_id' = customer_filter or rs.clean_json_data->>'project_id' = customer_filter or rs.clean_json_data->>'client' ilike '%' || customer_filter || '%' or rs.clean_json_data->>'company_name' ilike '%' || customer_filter || '%' or rs.clean_json_data->>'customer' ilike '%' || customer_filter || '%' or rs.clean_json_data->>'name' ilike '%' || customer_filter || '%' or rs.jobcode_name ilike '%' || customer_filter || '%')
  ),
  deduped as (
    select distinct on (fr.record_dataset_id, fr.unique_key) fr.*
    from filtered_raw fr
    order by fr.record_dataset_id, fr.unique_key, fr.record_created_at desc
  ),
  counted as (
    select d.*, count(*) over() as result_total_count
    from deduped d
  )
  select
    c.record_id,
    c.record_dataset_id,
    c.record_dataset_name,
    c.record_json_data,
    c.record_created_at,
    c.result_total_count
  from counted c
  order by
    case when sort_field = 'dataset' and sort_is_asc then c.record_dataset_name end asc,
    case when sort_field = 'dataset' and not sort_is_asc then c.record_dataset_name end desc,
    case when sort_field = 'created_at' and sort_is_asc then c.record_created_at end asc,
    case when sort_field = 'created_at' and not sort_is_asc then c.record_created_at end desc,
    c.record_created_at desc
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
    select
      (r.json_data->>'id')::text as employee_id,
      coalesce(nullif(trim(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')), ''), r.json_data->>'email', r.json_data->>'username', r.json_data->>'id') as employee_name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Employees'
      and public.can_access_dataset(r.dataset_id)
  ),
  records_scope as (
    select
      r.id as record_id,
      r.dataset_id as record_dataset_id,
      d.name as record_dataset_name,
      r.json_data - 'pto_balances' - 'time_off_type' - 'time_off_request_id' as clean_json_data,
      r.created_at as record_created_at,
      coalesce(r.source_hash, r.id::text) as unique_key,
      coalesce(public.safe_date(r.json_data->>'date'), public.safe_date(r.json_data->>'local_date'), public.safe_date(left(r.json_data->>'start', 10)), r.created_at::date) as record_date,
      coalesce(public.safe_numeric(r.json_data->>'duration'), public.safe_numeric(r.json_data->>'hours') * 3600) as duration_seconds,
      coalesce(
        e.employee_name,
        nullif(trim(concat(r.json_data->>'fname', ' ', r.json_data->>'lname')), ''),
        nullif(trim(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')), ''),
        nullif(r.json_data->>'employee_name', ''),
        nullif(r.json_data->>'username', ''),
        nullif(r.json_data->>'email', '')
      ) as employee_name,
      coalesce(nullif(r.json_data->>'jobcode_3', ''), nullif(r.json_data->>'jobcode_2', ''), nullif(r.json_data->>'jobcode_1', ''), nullif(r.json_data->>'jobcode_name', ''), nullif(r.json_data->>'name', ''), nullif(r.json_data->>'short_code', ''), nullif(r.json_data->>'jobcode_id', '')) as jobcode_name,
      coalesce(nullif(r.json_data #>> '{customfields,53105}', ''), nullif(r.json_data->>'service item', ''), nullif(r.json_data->>'service_item', '')) as service_item
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    left join employees e on e.employee_id = r.json_data->>'user_id'
    where public.can_access_dataset(r.dataset_id)
      and d.name <> 'QuickBooks Time PTO'
      and (dataset_uuid is null or r.dataset_id = dataset_uuid)
  ),
  filtered_raw as materialized (
    select rs.*
    from records_scope rs
    where (coalesce(search_term, '') = '' or rs.clean_json_data::text ilike '%' || search_term || '%' or rs.record_dataset_name ilike '%' || search_term || '%' or rs.employee_name ilike '%' || search_term || '%' or rs.jobcode_name ilike '%' || search_term || '%' or rs.service_item ilike '%' || search_term || '%')
      and (coalesce(exact_key, '') = '' or coalesce(rs.clean_json_data->>exact_key, '') = coalesce(exact_value, ''))
      and (start_date is null or rs.record_created_at >= start_date or rs.record_date >= start_date::date)
      and (end_date is null or rs.record_created_at <= end_date or rs.record_date <= end_date::date)
      and (coalesce(user_filter, '') = '' or rs.clean_json_data->>'user_id' = user_filter or rs.clean_json_data->>'created_by_user_id' = user_filter or rs.clean_json_data->>'username' ilike '%' || user_filter || '%' or rs.clean_json_data->>'email' ilike '%' || user_filter || '%')
      and (coalesce(employee_filter, '') = '' or rs.clean_json_data->>'user_id' = employee_filter or rs.employee_name ilike '%' || employee_filter || '%' or concat_ws(' ', rs.clean_json_data->>'first_name', rs.clean_json_data->>'last_name') ilike '%' || employee_filter || '%' or concat_ws(' ', rs.clean_json_data->>'fname', rs.clean_json_data->>'lname') ilike '%' || employee_filter || '%' or rs.clean_json_data->>'employee_number' = employee_filter)
      and (coalesce(jobcode_filter, '') = '' or rs.clean_json_data->>'jobcode_id' = jobcode_filter or rs.clean_json_data->>'name' ilike '%' || jobcode_filter || '%' or rs.clean_json_data->>'short_code' ilike '%' || jobcode_filter || '%' or rs.clean_json_data->>'jobcode_1' ilike '%' || jobcode_filter || '%' or rs.clean_json_data->>'jobcode_2' ilike '%' || jobcode_filter || '%' or rs.clean_json_data->>'jobcode_3' ilike '%' || jobcode_filter || '%' or rs.jobcode_name ilike '%' || jobcode_filter || '%')
      and (coalesce(service_item_filter, '') = '' or rs.service_item ilike '%' || service_item_filter || '%' or rs.clean_json_data->>'service_item' ilike '%' || service_item_filter || '%')
      and (coalesce(status_filter, '') = '' or lower(coalesce(rs.clean_json_data->>'status', rs.clean_json_data->>'state', rs.clean_json_data->>'active', '')) = lower(status_filter))
      and (coalesce(customer_filter, '') = '' or rs.clean_json_data->>'client_id' = customer_filter or rs.clean_json_data->>'project_id' = customer_filter or rs.clean_json_data->>'client' ilike '%' || customer_filter || '%' or rs.clean_json_data->>'company_name' ilike '%' || customer_filter || '%' or rs.clean_json_data->>'customer' ilike '%' || customer_filter || '%' or rs.clean_json_data->>'name' ilike '%' || customer_filter || '%' or rs.jobcode_name ilike '%' || customer_filter || '%')
  ),
  deduped as materialized (
    select distinct on (fr.record_dataset_id, fr.unique_key) fr.*
    from filtered_raw fr
    order by fr.record_dataset_id, fr.unique_key, fr.record_created_at desc
  ),
  dataset_rows as (
    select coalesce(jsonb_agg(jsonb_build_object('id', s.record_dataset_id, 'name', s.record_dataset_name, 'records', s.records) order by s.records desc, s.record_dataset_name), '[]'::jsonb) as rows
    from (
      select d.record_dataset_id, d.record_dataset_name, count(*)::int as records
      from deduped d
      group by d.record_dataset_id, d.record_dataset_name
      order by 3 desc
      limit 12
    ) s
  ),
  day_rows as (
    select coalesce(jsonb_agg(jsonb_build_object('date', s.record_date, 'records', s.records) order by s.record_date), '[]'::jsonb) as rows
    from (
      select d.record_date, count(*)::int as records
      from deduped d
      where d.record_date is not null
      group by d.record_date
      order by d.record_date
    ) s
  )
  select jsonb_build_object(
    'dataset_name', (select ds.name from public.datasets ds where ds.id = dataset_uuid),
    'raw_records', (select count(*) from filtered_raw),
    'unique_records', (select count(*) from deduped),
    'duplicates_removed', (select greatest((select count(*) from filtered_raw) - (select count(*) from deduped), 0)),
    'dataset_count', (select count(distinct d.record_dataset_id) from deduped d),
    'employee_count', (select count(distinct coalesce(nullif(d.employee_name, ''), nullif(d.clean_json_data->>'user_id', ''), nullif(d.clean_json_data->>'employee_number', ''), nullif(d.clean_json_data->>'email', ''))) from deduped d),
    'jobcode_count', (select count(distinct coalesce(nullif(d.clean_json_data->>'jobcode_id', ''), nullif(d.jobcode_name, ''), nullif(d.clean_json_data->>'name', ''), nullif(d.clean_json_data->>'short_code', ''))) from deduped d),
    'service_item_count', (select count(distinct nullif(d.service_item, '')) from deduped d),
    'hours', (select coalesce(round((sum(coalesce(d.duration_seconds, 0)) / 3600)::numeric, 2), 0) from deduped d),
    'date_start', (select min(d.record_date) from deduped d),
    'date_end', (select max(d.record_date) from deduped d),
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
