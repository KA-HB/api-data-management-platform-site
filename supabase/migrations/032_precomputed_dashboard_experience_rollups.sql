create table if not exists public.dashboard_experience_rollups (
  dataset_id uuid not null,
  dataset_name text not null,
  work_date date not null,
  employee text not null,
  employee_id text,
  jobcode_level1 text,
  jobcode_level2 text,
  jobcode_level3 text,
  jobcode text not null,
  service_item text not null,
  search_text text not null,
  hours numeric not null default 0,
  timesheets integer not null default 0,
  first_work date not null,
  last_work date not null,
  refreshed_at timestamptz not null default now()
);

alter table public.dashboard_experience_rollups enable row level security;
revoke all on table public.dashboard_experience_rollups from public;
revoke all on table public.dashboard_experience_rollups from anon;
revoke all on table public.dashboard_experience_rollups from authenticated;

create index if not exists dashboard_experience_rollups_dataset_idx
on public.dashboard_experience_rollups(dataset_id);

create index if not exists dashboard_experience_rollups_work_date_idx
on public.dashboard_experience_rollups(work_date);

create index if not exists dashboard_experience_rollups_employee_idx
on public.dashboard_experience_rollups(employee);

create index if not exists dashboard_experience_rollups_employee_id_idx
on public.dashboard_experience_rollups(employee_id);

create index if not exists dashboard_experience_rollups_jobcode_l1_idx
on public.dashboard_experience_rollups(jobcode_level1);

create index if not exists dashboard_experience_rollups_jobcode_l2_idx
on public.dashboard_experience_rollups(jobcode_level2);

create index if not exists dashboard_experience_rollups_jobcode_l3_idx
on public.dashboard_experience_rollups(jobcode_level3);

create index if not exists dashboard_experience_rollups_jobcode_idx
on public.dashboard_experience_rollups(jobcode);

create index if not exists dashboard_experience_rollups_service_idx
on public.dashboard_experience_rollups(service_item);

create index if not exists dashboard_experience_rollups_search_trgm_idx
on public.dashboard_experience_rollups using gin (search_text gin_trgm_ops);

create or replace function public.refresh_dashboard_experience_rollups()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  truncate table public.dashboard_experience_rollups;

  insert into public.dashboard_experience_rollups (
    dataset_id,
    dataset_name,
    work_date,
    employee,
    employee_id,
    jobcode_level1,
    jobcode_level2,
    jobcode_level3,
    jobcode,
    service_item,
    search_text,
    hours,
    timesheets,
    first_work,
    last_work,
    refreshed_at
  )
  select
    e.dataset_id,
    e.dataset_name,
    e.work_date,
    e.employee,
    e.employee_id,
    e.jobcode_level1,
    e.jobcode_level2,
    e.jobcode_level3,
    e.jobcode,
    e.service_item,
    lower(concat_ws(
      ' ',
      e.dataset_name,
      e.employee,
      e.employee_id,
      e.jobcode_level1,
      e.jobcode_level2,
      e.jobcode_level3,
      e.jobcode,
      e.service_item
    )) as search_text,
    round(sum(e.hours)::numeric, 2) as hours,
    count(*)::integer as timesheets,
    min(e.work_date) as first_work,
    max(e.work_date) as last_work,
    now() as refreshed_at
  from public.dashboard_experience_unique_records e
  where e.employee <> 'Unassigned'
  group by
    e.dataset_id,
    e.dataset_name,
    e.work_date,
    e.employee,
    e.employee_id,
    e.jobcode_level1,
    e.jobcode_level2,
    e.jobcode_level3,
    e.jobcode,
    e.service_item;

  analyze public.dashboard_experience_rollups;
end;
$$;

create or replace function public.refresh_dashboard_experience_records()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view public.dashboard_experience_records;
  refresh materialized view public.dashboard_experience_unique_records;
  perform public.refresh_dashboard_experience_rollups();
end;
$$;

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

revoke all on function public.refresh_dashboard_experience_rollups() from public;
revoke all on function public.refresh_dashboard_experience_records() from public;
revoke all on function public.dashboard_qbtime_rollups(uuid, text, text, date, date, text, text, text, text) from public;
grant execute on function public.refresh_dashboard_experience_rollups() to authenticated;
grant execute on function public.refresh_dashboard_experience_records() to authenticated;
grant execute on function public.dashboard_qbtime_rollups(uuid, text, text, date, date, text, text, text, text) to authenticated;

select public.refresh_dashboard_experience_rollups();
