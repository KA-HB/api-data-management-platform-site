drop materialized view if exists public.dashboard_experience_records;

create materialized view public.dashboard_experience_records as
with employees as (
  select distinct on (r.json_data->>'id')
    r.json_data->>'id' as employee_id,
    coalesce(
      nullif(trim(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')), ''),
      nullif(r.json_data->>'email', ''),
      nullif(r.json_data->>'username', ''),
      r.json_data->>'id'
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
      e.employee_name,
      nullif(trim(concat(r.json_data->>'fname', ' ', r.json_data->>'lname')), ''),
      nullif(trim(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')), ''),
      nullif(r.json_data->>'employee_name', ''),
      nullif(r.json_data->>'username', ''),
      nullif(r.json_data->>'email', ''),
      nullif(r.json_data->>'user_id', ''),
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

create unique index dashboard_experience_records_record_idx
on public.dashboard_experience_records(record_id);

create index dashboard_experience_records_dataset_idx
on public.dashboard_experience_records(dataset_id);

create index dashboard_experience_records_unique_idx
on public.dashboard_experience_records(unique_key);

create index dashboard_experience_records_work_date_idx
on public.dashboard_experience_records(work_date);

create index dashboard_experience_records_employee_idx
on public.dashboard_experience_records(employee);

create index dashboard_experience_records_jobcode_idx
on public.dashboard_experience_records(jobcode);

create index dashboard_experience_records_service_idx
on public.dashboard_experience_records(service_item);

create index dashboard_experience_records_search_trgm_idx
on public.dashboard_experience_records using gin (search_text gin_trgm_ops);

create or replace function public.refresh_dashboard_experience_records()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view public.dashboard_experience_records;
end;
$$;

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
  auth_user_id uuid := auth.uid();
  is_admin_user boolean := public.is_admin();
  keyword text := lower(coalesce(keyword_filter, ''));
begin
  if auth_user_id is null then
    raise exception 'Authentication required';
  end if;

  with allowed_datasets as (
    select d.id, d.name
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
    select e.*
    from public.dashboard_experience_records e
    join allowed_datasets d on d.id = e.dataset_id
    where (start_date is null or e.work_date >= start_date)
      and (end_date is null or e.work_date <= end_date)
      and (coalesce(employee_filter, '') = '' or e.employee_id = employee_filter or e.employee ilike '%' || employee_filter || '%')
      and (coalesce(jobcode_level1_filter, '') = '' or e.jobcode_level1 ilike '%' || jobcode_level1_filter || '%' or e.jobcode ilike '%' || jobcode_level1_filter || '%')
      and (coalesce(jobcode_level2_filter, '') = '' or e.jobcode_level2 ilike '%' || jobcode_level2_filter || '%' or e.jobcode ilike '%' || jobcode_level2_filter || '%')
      and (coalesce(jobcode_level3_filter, '') = '' or e.jobcode_level3 ilike '%' || jobcode_level3_filter || '%' or e.jobcode ilike '%' || jobcode_level3_filter || '%')
      and (coalesce(service_item_filter, '') = '' or e.service_item ilike '%' || service_item_filter || '%')
      and (
        keyword = ''
        or e.search_text ilike '%' || keyword || '%'
        or lower(e.dataset_name) ilike '%' || keyword || '%'
        or lower(e.employee) ilike '%' || keyword || '%'
        or lower(e.jobcode) ilike '%' || keyword || '%'
        or lower(e.service_item) ilike '%' || keyword || '%'
      )
  ),
  deduped as materialized (
    select distinct on (unique_key) *
    from scoped
    order by unique_key, work_date desc, record_id
  ),
  hours_by_employee as (
    select coalesce(jsonb_agg(jsonb_build_object('employee', employee, 'hours', round(hours::numeric, 2), 'timesheets', timesheets) order by hours desc), '[]'::jsonb) as rows
    from (
      select employee, sum(hours) as hours, count(*)::int as timesheets
      from deduped
      group by employee
      order by 2 desc
      limit 15
    ) s
  ),
  hours_by_jobcode as (
    select coalesce(jsonb_agg(jsonb_build_object('jobcode', jobcode, 'hours', round(hours::numeric, 2)) order by hours desc), '[]'::jsonb) as rows
    from (
      select coalesce(nullif(concat_ws(' / ', jobcode_level1, jobcode_level2, jobcode_level3), ''), jobcode) as jobcode, sum(hours) as hours
      from deduped
      group by 1
      order by 2 desc
      limit 15
    ) s
  ),
  hours_by_service_item as (
    select coalesce(jsonb_agg(jsonb_build_object('service_item', service_item, 'hours', round(hours::numeric, 2)) order by hours desc), '[]'::jsonb) as rows
    from (
      select service_item, sum(hours) as hours
      from deduped
      group by service_item
      order by 2 desc
      limit 15
    ) s
  ),
  hours_by_day as (
    select coalesce(jsonb_agg(jsonb_build_object('date', work_date, 'hours', round(hours::numeric, 2)) order by work_date), '[]'::jsonb) as rows
    from (
      select work_date, sum(hours) as hours
      from deduped
      group by work_date
      order by work_date
    ) s
  ),
  records_by_dataset as (
    select coalesce(jsonb_agg(jsonb_build_object('name', dataset_name, 'records', records) order by records desc, dataset_name), '[]'::jsonb) as rows
    from (
      select dataset_name, count(*)::int as records
      from deduped
      group by dataset_name
      order by 2 desc
      limit 12
    ) s
  ),
  records_by_day as (
    select coalesce(jsonb_agg(jsonb_build_object('date', work_date, 'records', records) order by work_date), '[]'::jsonb) as rows
    from (
      select work_date, count(*)::int as records
      from deduped
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
        count(*)::int as timesheets,
        count(distinct nullif(jobcode, 'Unassigned'))::int as jobcodes,
        count(distinct nullif(service_item, 'No service item'))::int as service_items,
        min(work_date) as first_work,
        max(work_date) as last_work
      from deduped
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
        count(*)::int as timesheets,
        min(work_date) as first_work,
        max(work_date) as last_work
      from deduped
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
    'filtered_timesheets', (select count(*) from deduped),
    'filtered_hours', (select coalesce(round(sum(hours)::numeric, 2), 0) from deduped),
    'filtered_employees', (select count(distinct nullif(employee, 'Unassigned')) from deduped),
    'filtered_jobcodes', (select count(distinct nullif(jobcode, 'Unassigned')) from deduped),
    'filtered_service_items', (select count(distinct nullif(service_item, 'No service item')) from deduped),
    'raw_records', (select count(*) from scoped),
    'unique_records', (select count(*) from deduped),
    'dataset_count', (select count(distinct dataset_id) from deduped),
    'date_start', (select min(work_date) from deduped),
    'date_end', (select max(work_date) from deduped)
  ) into result;

  return result;
end;
$$;

revoke all on function public.refresh_dashboard_experience_records() from public;
grant execute on function public.refresh_dashboard_experience_records() to authenticated;

revoke all on function public.dashboard_qbtime_rollups(uuid, text, text, date, date, text, text, text, text) from public;
grant execute on function public.dashboard_qbtime_rollups(uuid, text, text, date, date, text, text, text, text) to authenticated;
