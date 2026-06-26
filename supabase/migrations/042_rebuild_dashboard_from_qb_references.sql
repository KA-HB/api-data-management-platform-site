-- Rebuild the experience dashboard from the synced QuickBooks Time reference data.
-- Active employees come from the Employees dataset. Job Code 1/2/3 names come
-- from the Job Codes hierarchy, with the timesheet service path as a fallback
-- for older job-code ids that are no longer returned by the active API list.

create or replace function public.clean_jobcode_label(value text)
returns text
language sql
immutable
as $$
  select case
    when value is null then null
    when btrim(value) = '' then null
    when btrim(value) = '0' then null
    when btrim(value) ~ '^[0-9]+$' then null
    when btrim(value) ~* '(^|[[:space:]_:/-])(pto|sick|holiday|overhead)($|[[:space:]_:/-])' then null
    when btrim(value) ~* '^(unassigned|not specified|no job code( [123])?)$' then null
    else btrim(regexp_replace(value, '\s+', ' ', 'g'))
  end;
$$;

revoke all on function public.clean_jobcode_label(text) from public;
grant execute on function public.clean_jobcode_label(text) to authenticated;

drop materialized view if exists public.dashboard_experience_unique_records;
drop materialized view if exists public.dashboard_experience_records;

create materialized view public.dashboard_experience_records as
with active_employees as (
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
    and coalesce((r.json_data->>'active')::boolean, false)
    and coalesce((r.json_data #>> '{permissions,time_tracking}')::boolean, true)
    and coalesce(r.json_data->>'term_date', '0000-00-00') in ('', '0000-00-00')
  order by r.json_data->>'id', r.created_at desc
),
jobcodes as (
  select distinct on (r.json_data->>'id')
    r.json_data->>'id' as jobcode_id,
    nullif(r.json_data->>'parent_id', '0') as parent_id,
    coalesce(
      public.clean_jobcode_label(r.json_data->>'name'),
      public.clean_jobcode_label(r.json_data->>'short_code')
    ) as jobcode_name
  from public.records r
  join public.datasets d on d.id = r.dataset_id
  where d.name = 'QuickBooks Time Job Codes'
    and coalesce(r.json_data->>'id', '') <> ''
  order by r.json_data->>'id',
    (coalesce(public.clean_jobcode_label(r.json_data->>'name'), public.clean_jobcode_label(r.json_data->>'short_code')) is not null) desc,
    r.created_at desc
),
job_paths as (
  select
    leaf.jobcode_id,
    case
      when root.jobcode_id is not null then root.jobcode_name
      when parent.jobcode_id is not null then parent.jobcode_name
      else leaf.jobcode_name
    end as level1_name,
    case
      when root.jobcode_id is not null then parent.jobcode_name
      when parent.jobcode_id is not null then leaf.jobcode_name
      else null
    end as level2_name,
    case
      when root.jobcode_id is not null then leaf.jobcode_name
      else null
    end as level3_name,
    leaf.jobcode_name
  from jobcodes leaf
  left join jobcodes parent on parent.jobcode_id = leaf.parent_id
  left join jobcodes root on root.jobcode_id = parent.parent_id
),
timesheets as (
  select
    r.*,
    d.name as dataset_name,
    coalesce(nullif(r.json_data #>> '{customfields,53105}', ''), '') as service_path,
    string_to_array(coalesce(nullif(r.json_data #>> '{customfields,53105}', ''), ''), ':') as service_parts
  from public.records r
  join public.datasets d on d.id = r.dataset_id
  where d.name = 'QuickBooks Time Timesheets'
    and r.duration_seconds is not null
    and r.duration_seconds > 0
    and r.work_date is not null
    and coalesce(r.json_data->>'jobcode_id', '') not in ('9072642', '9072644', '9072646')
),
experience as (
  select
    coalesce(t.source_hash, t.id::text) as unique_key,
    t.id as record_id,
    t.dataset_id,
    t.dataset_name,
    t.json_data,
    t.search_text,
    t.work_date,
    coalesce(t.duration_seconds, 0) / 3600.0 as hours,
    e.employee_name as employee,
    e.employee_id,
    public.clean_jobcode_label(coalesce(
      jp.level1_name,
      nullif(btrim(t.service_parts[1]), ''),
      t.json_data->>'jobcode_1',
      t.json_data->>'parent_jobcode_name'
    )) as jobcode_level1,
    public.clean_jobcode_label(coalesce(
      jp.level2_name,
      case when array_length(t.service_parts, 1) >= 3 then nullif(btrim(t.service_parts[2]), '') end,
      t.json_data->>'jobcode_2'
    )) as jobcode_level2,
    public.clean_jobcode_label(coalesce(
      jp.level3_name,
      case when array_length(t.service_parts, 1) >= 4 then nullif(btrim(t.service_parts[3]), '') end,
      t.json_data->>'jobcode_3'
    )) as jobcode_level3,
    public.clean_jobcode_label(coalesce(
      jp.level3_name,
      jp.level2_name,
      jp.level1_name,
      jp.jobcode_name,
      t.json_data->>'jobcode_3',
      t.json_data->>'jobcode_2',
      t.json_data->>'jobcode_1',
      t.json_data->>'jobcode_name',
      case when array_length(t.service_parts, 1) >= 2 then nullif(btrim(t.service_parts[1]), '') end
    )) as jobcode,
    coalesce(
      public.clean_jobcode_label(case when array_length(t.service_parts, 1) >= 1 then nullif(btrim(t.service_parts[array_length(t.service_parts, 1)]), '') end),
      public.clean_jobcode_label(t.json_data->>'service item'),
      public.clean_jobcode_label(t.json_data->>'service_item'),
      'No service item'
    ) as service_item,
    t.service_path
  from timesheets t
  join active_employees e on e.employee_id = t.json_data->>'user_id'
  left join job_paths jp on jp.jobcode_id = t.json_data->>'jobcode_id'
),
filtered as (
  select *
  from experience
  where employee is not null
    and public.clean_jobcode_label(coalesce(jobcode_level1, jobcode, service_path)) is not null
    and coalesce(jobcode_level1, jobcode, service_path, '') !~* '(^|[[:space:]_:/-])(pto|sick|holiday|overhead)($|[[:space:]_:/-])'
    and coalesce(service_path, '') !~* '(^|[[:space:]_:/-])(pto|sick|holiday|overhead)($|[[:space:]_:/-])'
)
select
  unique_key,
  record_id,
  dataset_id,
  dataset_name,
  json_data,
  search_text,
  work_date,
  hours,
  employee,
  employee_id,
  jobcode_level1,
  jobcode_level2,
  jobcode_level3,
  coalesce(jobcode, jobcode_level3, jobcode_level2, jobcode_level1, 'Unassigned') as jobcode,
  service_item
from filtered;

create unique index dashboard_experience_records_record_idx on public.dashboard_experience_records(record_id);
create index dashboard_experience_records_dataset_idx on public.dashboard_experience_records(dataset_id);
create index dashboard_experience_records_unique_idx on public.dashboard_experience_records(unique_key);
create index dashboard_experience_records_work_date_idx on public.dashboard_experience_records(work_date);
create index dashboard_experience_records_employee_idx on public.dashboard_experience_records(employee);
create index dashboard_experience_records_employee_id_idx on public.dashboard_experience_records(employee_id);
create index dashboard_experience_records_jobcode_idx on public.dashboard_experience_records(jobcode);
create index dashboard_experience_records_jobcode_l1_idx on public.dashboard_experience_records(jobcode_level1);
create index dashboard_experience_records_jobcode_l2_idx on public.dashboard_experience_records(jobcode_level2);
create index dashboard_experience_records_jobcode_l3_idx on public.dashboard_experience_records(jobcode_level3);
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
create index dashboard_experience_unique_records_employee_id_idx on public.dashboard_experience_unique_records(employee_id);
create index dashboard_experience_unique_records_jobcode_idx on public.dashboard_experience_unique_records(jobcode);
create index dashboard_experience_unique_records_jobcode_l1_idx on public.dashboard_experience_unique_records(jobcode_level1);
create index dashboard_experience_unique_records_jobcode_l2_idx on public.dashboard_experience_unique_records(jobcode_level2);
create index dashboard_experience_unique_records_jobcode_l3_idx on public.dashboard_experience_unique_records(jobcode_level3);
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
  if to_regclass('public.dashboard_experience_rollups') is not null then
    perform public.refresh_dashboard_experience_rollups();
  end if;
end;
$$;

revoke all on function public.refresh_dashboard_experience_records() from public;
revoke all on function public.refresh_dashboard_experience_records() from anon;
grant execute on function public.refresh_dashboard_experience_records() to authenticated;

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
  ),
  scoped as materialized (
    select e.*
    from public.dashboard_experience_unique_records e
    join allowed_datasets d on d.id = e.dataset_id
    where e.employee <> 'Unassigned'
      and e.hours > 0
  ),
  employees as (
    select distinct employee_id as id, employee as name
    from scoped
    where public.clean_employee_label(employee) is not null
      and employee !~ '^[0-9]+$'
      and employee !~* '^user [0-9]+$'
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

select public.refresh_dashboard_experience_records();
