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
    else btrim(regexp_replace(value, '\s+', ' ', 'g'))
  end;
$$;

revoke all on function public.clean_jobcode_label(text) from public;
grant execute on function public.clean_jobcode_label(text) to authenticated;

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
  order by r.json_data->>'id', (coalesce(public.clean_jobcode_label(r.json_data->>'name'), public.clean_jobcode_label(r.json_data->>'short_code')) is not null) desc, r.created_at desc
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
    coalesce(public.clean_jobcode_label(jp.level1_name), public.clean_jobcode_label(r.json_data->>'jobcode_1'), public.clean_jobcode_label(r.json_data->>'parent_jobcode_name')) as jobcode_level1,
    coalesce(public.clean_jobcode_label(jp.level2_name), public.clean_jobcode_label(r.json_data->>'jobcode_2')) as jobcode_level2,
    coalesce(public.clean_jobcode_label(jp.level3_name), public.clean_jobcode_label(r.json_data->>'jobcode_3')) as jobcode_level3,
    coalesce(
      public.clean_jobcode_label(jp.level3_name),
      public.clean_jobcode_label(jp.level2_name),
      public.clean_jobcode_label(jp.level1_name),
      public.clean_jobcode_label(r.json_data->>'jobcode_3'),
      public.clean_jobcode_label(r.json_data->>'jobcode_2'),
      public.clean_jobcode_label(r.json_data->>'jobcode_1'),
      public.clean_jobcode_label(r.json_data->>'jobcode_name'),
      public.clean_jobcode_label(jp.jobcode_name),
      public.clean_jobcode_label(r.json_data->>'name'),
      public.clean_jobcode_label(r.json_data->>'short_code'),
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
  left join job_paths jp on jp.jobcode_id = r.json_data->>'jobcode_id'
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

select public.refresh_dashboard_experience_records();
