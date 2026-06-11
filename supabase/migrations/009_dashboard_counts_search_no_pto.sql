create or replace function public.dashboard_summary()
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

  with authorized_datasets as (
    select d.*
    from public.datasets d
    where public.can_access_dataset(d.id)
      and d.name <> 'QuickBooks Time PTO'
  ),
  authorized_records as (
    select r.*
    from public.records r
    join authorized_datasets d on d.id = r.dataset_id
  ),
  dataset_counts as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'name', name,
      'source_type', source_type,
      'record_count', actual_count,
      'updated_at', updated_at
    ) order by actual_count desc, name), '[]'::jsonb) as rows
    from (
      select d.id, d.name, d.source_type, d.updated_at, count(r.id)::int as actual_count
      from authorized_datasets d
      left join public.records r on r.dataset_id = d.id
      group by d.id, d.name, d.source_type, d.updated_at
    ) s
  ),
  records_by_day as (
    select coalesce(jsonb_agg(jsonb_build_object('date', day, 'records', records) order by day), '[]'::jsonb) as rows
    from (
      select date_trunc('day', created_at)::date as day, count(*)::int as records
      from authorized_records
      where created_at >= now() - interval '30 days'
      group by 1
    ) s
  ),
  api_by_day as (
    select coalesce(jsonb_agg(jsonb_build_object('date', day, 'calls', calls) order by day), '[]'::jsonb) as rows
    from (
      select date_trunc('day', last_used_at)::date as day, count(*)::int as calls
      from public.api_keys
      where last_used_at is not null
        and (public.is_admin() or user_id = auth.uid())
        and last_used_at >= now() - interval '30 days'
      group by 1
    ) s
  ),
  activity_by_day as (
    select coalesce(jsonb_agg(jsonb_build_object('date', day, 'events', events) order by day), '[]'::jsonb) as rows
    from (
      select date_trunc('day', created_at)::date as day, count(*)::int as events
      from public.activity_logs
      where (public.is_admin() or user_id = auth.uid())
        and created_at >= now() - interval '30 days'
      group by 1
    ) s
  ),
  recent_uploads as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', name,
      'source_type', source_type,
      'record_count', actual_count,
      'updated_at', updated_at
    ) order by updated_at desc), '[]'::jsonb) as rows
    from (
      select d.name, d.source_type, d.updated_at, count(r.id)::int as actual_count
      from authorized_datasets d
      left join public.records r on r.dataset_id = d.id
      group by d.id, d.name, d.source_type, d.updated_at
      order by d.updated_at desc
      limit 8
    ) s
  ),
  recent_syncs as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'provider', provider,
      'status', status,
      'message', message,
      'stats', stats,
      'started_at', started_at,
      'finished_at', finished_at
    ) order by started_at desc), '[]'::jsonb) as rows
    from (
      select * from public.sync_logs
      where public.is_admin()
      order by started_at desc
      limit 8
    ) s
  )
  select jsonb_build_object(
    'role', public.current_user_role(),
    'users', case when public.is_admin() then (select count(*) from public.profiles) else null end,
    'datasets', (select count(*) from authorized_datasets),
    'records', (select count(*) from authorized_records),
    'api_keys', (select count(*) from public.api_keys where public.is_admin() or user_id = auth.uid()),
    'active_api_keys', (select count(*) from public.api_keys where revoked = false and (public.is_admin() or user_id = auth.uid())),
    'last_sync_status', (select status from public.sync_logs where public.is_admin() order by started_at desc limit 1),
    'last_sync_at', (select finished_at from public.sync_logs where public.is_admin() order by started_at desc limit 1),
    'records_by_dataset', (select rows from dataset_counts),
    'records_by_day', (select rows from records_by_day),
    'api_calls_by_day', (select rows from api_by_day),
    'activity_by_day', (select rows from activity_by_day),
    'recent_uploads', (select rows from recent_uploads),
    'recent_syncs', (select rows from recent_syncs)
  ) into result;

  return result;
end;
$$;

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
  with filtered as (
    select r.id, r.dataset_id, d.name as dataset_name, r.json_data, r.created_at
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where public.can_access_dataset(r.dataset_id)
      and d.name <> 'QuickBooks Time PTO'
      and (dataset_uuid is null or r.dataset_id = dataset_uuid)
      and (coalesce(search_term, '') = '' or r.json_data::text ilike '%' || search_term || '%' or d.name ilike '%' || search_term || '%')
      and (coalesce(exact_key, '') = '' or coalesce(r.json_data->>exact_key, '') = coalesce(exact_value, ''))
      and (start_date is null or r.created_at >= start_date or public.safe_date(r.json_data->>'date') >= start_date::date or public.safe_date(left(r.json_data->>'start', 10)) >= start_date::date)
      and (end_date is null or r.created_at <= end_date or public.safe_date(r.json_data->>'date') <= end_date::date or public.safe_date(left(r.json_data->>'end', 10)) <= end_date::date)
      and (coalesce(user_filter, '') = '' or r.json_data->>'user_id' = user_filter or r.json_data->>'created_by_user_id' = user_filter or r.json_data->>'username' ilike '%' || user_filter || '%' or r.json_data->>'email' ilike '%' || user_filter || '%')
      and (coalesce(employee_filter, '') = '' or r.json_data->>'user_id' = employee_filter or concat_ws(' ', r.json_data->>'first_name', r.json_data->>'last_name') ilike '%' || employee_filter || '%' or r.json_data->>'employee_number' = employee_filter)
      and (coalesce(jobcode_filter, '') = '' or r.json_data->>'jobcode_id' = jobcode_filter or r.json_data->>'name' ilike '%' || jobcode_filter || '%' or r.json_data->>'short_code' ilike '%' || jobcode_filter || '%')
      and (coalesce(status_filter, '') = '' or r.json_data->>'status' = status_filter or r.json_data->>'state' = status_filter or r.json_data->>'active' = status_filter)
      and (coalesce(customer_filter, '') = '' or d.name ilike '%customer%' or r.json_data->>'client_id' = customer_filter or r.json_data->>'client' ilike '%' || customer_filter || '%' or r.json_data->>'company_name' ilike '%' || customer_filter || '%')
  ),
  counted as (
    select filtered.*, count(*) over() as total_count
    from filtered
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

revoke all on function public.dashboard_summary() from public;
grant execute on function public.dashboard_summary() to authenticated;

revoke all on function public.search_records_advanced(uuid, text, text, text, timestamptz, timestamptz, text, text, text, text, boolean, text, text, text, integer, integer) from public;
grant execute on function public.search_records_advanced(uuid, text, text, text, timestamptz, timestamptz, text, text, text, text, boolean, text, text, text, integer, integer) to authenticated;
