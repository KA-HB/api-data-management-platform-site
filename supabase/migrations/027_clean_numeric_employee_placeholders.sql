create or replace function public.clean_employee_label(value text)
returns text
language sql
immutable
as $$
  select case
    when value is null then null
    when btrim(value) = '' then null
    when btrim(value) ~ '^[0-9]+$' then null
    else btrim(value)
  end;
$$;

drop materialized view if exists public.dashboard_experience_unique_records;
drop materialized view if exists public.dashboard_experience_records;

create materialized view public.dashboard_experience_records as
with employees as (
  select distinct on (r.json_data->>'id')
    r.json_data->>'id' as employee_id,
    coalesce(
      public.clean_employee_label(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')),
      public.clean_employee_label(r.json_data->>'email'),
      public.clean_employee_label(r.json_data->>'username')
    ) as employee_name
  from public.records r
  join public.datasets d on d.id = r.dataset_id
  where d.name = 'QuickBooks Time Employees'
    and coalesce(r.json_data->>'id', '') <> ''
  order by r.json_data->>'id', r.created_at desc
),
experience as (
  select
    coalesce(r.source_hash, r.id::text) as unique_key,
    r.id as record_id,
    r.dataset_id,
    d.name as dataset_name,
    r.json_data,
    r.search_text,
    r.work_date,
    coalesce(r.duration_seconds, 0) / 3600 as hours,
    coalesce(
      public.clean_employee_label(e.employee_name),
      public.clean_employee_label(concat(r.json_data->>'fname', ' ', r.json_data->>'lname')),
      public.clean_employee_label(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')),
      public.clean_employee_label(r.json_data->>'employee_name'),
      public.clean_employee_label(r.json_data->>'display_name'),
      public.clean_employee_label(r.json_data->>'full_name'),
      public.clean_employee_label(r.json_data->>'username'),
      public.clean_employee_label(r.json_data->>'email'),
      'Unassigned'
    ) as employee,
    nullif(r.json_data->>'user_id', '') as employee_id,
    nullif(r.json_data->>'jobcode_1', '') as jobcode_level1,
    nullif(r.json_data->>'jobcode_2', '') as jobcode_level2,
    nullif(r.json_data->>'jobcode_3', '') as jobcode_level3,
    coalesce(
      nullif(r.json_data->>'jobcode_3', ''),
      nullif(r.json_data->>'jobcode_2', ''),
      nullif(r.json_data->>'jobcode_1', ''),
      nullif(r.json_data->>'jobcode_name', ''),
      nullif(r.json_data->>'name', ''),
      nullif(r.json_data->>'short_code', ''),
      nullif(r.json_data->>'jobcode_id', ''),
      'Unassigned'
    ) as jobcode,
    coalesce(
      nullif(r.json_data #>> '{customfields,53105}', ''),
      nullif(r.json_data->>'service item', ''),
      nullif(r.json_data->>'service_item', ''),
      'No service item'
    ) as service_item
  from public.records r
  join public.datasets d on d.id = r.dataset_id
  left join employees e on e.employee_id = r.json_data->>'user_id'
  where d.name <> 'QuickBooks Time PTO'
    and r.duration_seconds is not null
    and r.work_date is not null
)
select * from experience;

create unique index dashboard_experience_records_record_idx on public.dashboard_experience_records(record_id);
create index dashboard_experience_records_dataset_idx on public.dashboard_experience_records(dataset_id);
create index dashboard_experience_records_unique_idx on public.dashboard_experience_records(unique_key);
create index dashboard_experience_records_work_date_idx on public.dashboard_experience_records(work_date);
create index dashboard_experience_records_employee_idx on public.dashboard_experience_records(employee);
create index dashboard_experience_records_jobcode_idx on public.dashboard_experience_records(jobcode);
create index dashboard_experience_records_service_idx on public.dashboard_experience_records(service_item);
create index dashboard_experience_records_search_trgm_idx on public.dashboard_experience_records using gin (search_text gin_trgm_ops);

create materialized view public.dashboard_experience_unique_records as
select distinct on (unique_key) *
from public.dashboard_experience_records
order by unique_key, work_date desc, record_id;

create unique index dashboard_experience_unique_records_key_idx on public.dashboard_experience_unique_records(unique_key);
create index dashboard_experience_unique_records_dataset_idx on public.dashboard_experience_unique_records(dataset_id);
create index dashboard_experience_unique_records_work_date_idx on public.dashboard_experience_unique_records(work_date);
create index dashboard_experience_unique_records_employee_idx on public.dashboard_experience_unique_records(employee);
create index dashboard_experience_unique_records_jobcode_idx on public.dashboard_experience_unique_records(jobcode);
create index dashboard_experience_unique_records_service_idx on public.dashboard_experience_unique_records(service_item);
create index dashboard_experience_unique_records_search_trgm_idx on public.dashboard_experience_unique_records using gin (search_text gin_trgm_ops);

create or replace function public.refresh_dashboard_experience_records()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view public.dashboard_experience_records;
  refresh materialized view public.dashboard_experience_unique_records;
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
    select distinct employee_id as id, employee as name
    from public.dashboard_experience_unique_records
    where employee <> 'Unassigned'
      and public.clean_employee_label(employee) is not null
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
    'employees', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) from employees where coalesce(id, '') <> '' and coalesce(name, '') <> ''),
    'jobcode_level1', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) from level1 where coalesce(name, '') <> ''),
    'jobcode_level2', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id, 'parent_name', parent_name) order by parent_name, name), '[]'::jsonb) from level2 where coalesce(name, '') <> ''),
    'jobcode_level3', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id, 'parent_name', parent_name, 'grandparent_id', grandparent_id, 'grandparent_name', grandparent_name) order by grandparent_name, parent_name, name), '[]'::jsonb) from level3 where coalesce(name, '') <> ''),
    'service_items', (select coalesce(jsonb_agg(name order by name), '[]'::jsonb) from service_items where coalesce(name, '') <> '')
  ) into result;

  return result;
end;
$$;

revoke all on function public.clean_employee_label(text) from public;
grant execute on function public.clean_employee_label(text) to authenticated;

revoke all on function public.refresh_dashboard_experience_records() from public;
grant execute on function public.refresh_dashboard_experience_records() to authenticated;

revoke all on function public.dashboard_qbtime_filter_options() from public;
grant execute on function public.dashboard_qbtime_filter_options() to authenticated;
