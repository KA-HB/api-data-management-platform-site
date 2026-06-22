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
    coalesce(root.jobcode_name, parent.jobcode_name, leaf.jobcode_name) as level1_name,
    case when root.jobcode_id is null then null else parent.jobcode_name end as level2_name,
    case
      when root.jobcode_id is null and parent.jobcode_id is null then null
      when root.jobcode_id is null then null
      else leaf.jobcode_name
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
    select distinct on (r.json_data->>'id')
      r.json_data->>'id' as raw_id,
      nullif(r.json_data->>'parent_id', '0') as raw_parent_id,
      coalesce(public.clean_jobcode_label(r.json_data->>'name'), public.clean_jobcode_label(r.json_data->>'short_code')) as name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Job Codes'
      and coalesce(r.json_data->>'id', '') <> ''
    order by r.json_data->>'id', (coalesce(public.clean_jobcode_label(r.json_data->>'name'), public.clean_jobcode_label(r.json_data->>'short_code')) is not null) desc, r.created_at desc
  ),
  jobcode_paths as (
    select
      leaf.raw_id,
      leaf.name,
      parent.raw_id as parent_raw_id,
      parent.name as parent_name,
      grandparent.raw_id as grandparent_raw_id,
      grandparent.name as grandparent_name
    from jobcodes leaf
    left join jobcodes parent on parent.raw_id = leaf.raw_parent_id
    left join jobcodes grandparent on grandparent.raw_id = parent.raw_parent_id
  ),
  level1 as (
    select distinct name as id, name
    from jobcode_paths
    where parent_raw_id is null
      and public.clean_jobcode_label(name) is not null
    union
    select distinct jobcode_level1 as id, jobcode_level1 as name
    from public.dashboard_experience_unique_records
    where public.clean_jobcode_label(jobcode_level1) is not null
  ),
  level2 as (
    select distinct name as id, name, parent_name as parent_id, parent_name
    from jobcode_paths
    where parent_raw_id is not null
      and grandparent_raw_id is null
      and public.clean_jobcode_label(name) is not null
      and public.clean_jobcode_label(parent_name) is not null
    union
    select distinct jobcode_level2 as id, jobcode_level2 as name, jobcode_level1 as parent_id, jobcode_level1 as parent_name
    from public.dashboard_experience_unique_records
    where public.clean_jobcode_label(jobcode_level2) is not null
      and public.clean_jobcode_label(jobcode_level1) is not null
  ),
  level3 as (
    select distinct name as id, name, parent_name as parent_id, parent_name, grandparent_name as grandparent_id, grandparent_name
    from jobcode_paths
    where parent_raw_id is not null
      and grandparent_raw_id is not null
      and public.clean_jobcode_label(name) is not null
      and public.clean_jobcode_label(parent_name) is not null
      and public.clean_jobcode_label(grandparent_name) is not null
    union
    select distinct jobcode_level3 as id, jobcode_level3 as name, jobcode_level2 as parent_id, jobcode_level2 as parent_name, jobcode_level1 as grandparent_id, jobcode_level1 as grandparent_name
    from public.dashboard_experience_unique_records
    where public.clean_jobcode_label(jobcode_level3) is not null
      and public.clean_jobcode_label(jobcode_level2) is not null
      and public.clean_jobcode_label(jobcode_level1) is not null
  ),
  service_items as (
    select distinct service_item as name
    from public.dashboard_experience_unique_records
    where coalesce(service_item, '') <> ''
      and service_item <> 'No service item'
  )
  select jsonb_build_object(
    'employees', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) from employees where coalesce(id, '') <> '' and coalesce(name, '') <> ''),
    'jobcode_level1', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) from level1 where public.clean_jobcode_label(name) is not null),
    'jobcode_level2', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id, 'parent_name', parent_name) order by parent_name, name), '[]'::jsonb) from level2 where public.clean_jobcode_label(name) is not null),
    'jobcode_level3', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id, 'parent_name', parent_name, 'grandparent_id', grandparent_id, 'grandparent_name', grandparent_name) order by grandparent_name, parent_name, name), '[]'::jsonb) from level3 where public.clean_jobcode_label(name) is not null),
    'service_items', (select coalesce(jsonb_agg(name order by name), '[]'::jsonb) from service_items)
  ) into result;

  return result;
end;
$$;

drop function if exists public.qbtime_anomaly_detection(text, text, date, date, text, text, text, text, uuid, numeric, integer, integer);
drop function if exists public.qbtime_anomaly_detection(text, text, date, date, text, text, text, text, uuid, numeric, integer, integer, numeric, integer);

create or replace function public.qbtime_anomaly_detection(
  keyword_filter text default null,
  employee_filter text default null,
  start_date date default null,
  end_date date default null,
  jobcode_level1_filter text default null,
  jobcode_level2_filter text default null,
  jobcode_level3_filter text default null,
  service_item_filter text default null,
  dataset_uuid_filter uuid default null,
  min_hours numeric default 0.25,
  min_timesheets integer default 1,
  limit_count integer default 100,
  max_employee_share numeric default 0.05,
  max_timesheets integer default 3
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  lim integer := least(greatest(coalesce(limit_count, 100), 10), 250);
  min_hours_value numeric := greatest(coalesce(min_hours, 0.25), 0);
  min_timesheets_value integer := greatest(coalesce(min_timesheets, 1), 1);
  max_share_value numeric := least(greatest(coalesce(max_employee_share, 0.05), 0.001), 1);
  max_timesheets_value integer := greatest(coalesce(max_timesheets, 3), 1);
begin
  if not public.is_admin() then
    raise exception 'Admin role required';
  end if;

  with filtered as (
    select *
    from public.dashboard_experience_unique_records e
    where e.employee <> 'Unassigned'
      and e.hours > 0
      and (dataset_uuid_filter is null or e.dataset_id = dataset_uuid_filter)
      and public.matches_employee_name(e.employee, e.employee_id, employee_filter)
      and (start_date is null or e.work_date >= start_date)
      and (end_date is null or e.work_date <= end_date)
      and (coalesce(jobcode_level1_filter, '') = '' or e.jobcode_level1 ilike '%' || jobcode_level1_filter || '%' or e.jobcode ilike '%' || jobcode_level1_filter || '%')
      and (coalesce(jobcode_level2_filter, '') = '' or e.jobcode_level2 ilike '%' || jobcode_level2_filter || '%' or e.jobcode ilike '%' || jobcode_level2_filter || '%')
      and (coalesce(jobcode_level3_filter, '') = '' or e.jobcode_level3 ilike '%' || jobcode_level3_filter || '%' or e.jobcode ilike '%' || jobcode_level3_filter || '%')
      and (coalesce(service_item_filter, '') = '' or e.service_item ilike '%' || service_item_filter || '%')
      and (
        coalesce(keyword_filter, '') = ''
        or e.search_text ilike '%' || keyword_filter || '%'
        or public.matches_employee_name(e.employee, e.employee_id, keyword_filter)
        or e.jobcode_level1 ilike '%' || keyword_filter || '%'
        or e.jobcode_level2 ilike '%' || keyword_filter || '%'
        or e.jobcode_level3 ilike '%' || keyword_filter || '%'
        or e.jobcode ilike '%' || keyword_filter || '%'
        or e.service_item ilike '%' || keyword_filter || '%'
      )
  ),
  employee_combos as (
    select
      employee,
      coalesce(public.clean_jobcode_label(jobcode_level1), 'No Job Code 1') as jobcode_level1,
      coalesce(public.clean_jobcode_label(jobcode_level2), 'No Job Code 2') as jobcode_level2,
      coalesce(public.clean_jobcode_label(jobcode_level3), public.clean_jobcode_label(jobcode), 'No Job Code 3') as jobcode_level3,
      coalesce(public.clean_jobcode_label(jobcode), 'No job code') as jobcode,
      coalesce(nullif(service_item, ''), 'No service item') as service_item,
      sum(hours) as hours,
      count(*)::int as timesheets,
      min(work_date) as first_work,
      max(work_date) as last_work
    from filtered
    group by 1, 2, 3, 4, 5, 6
    having sum(hours) >= min_hours_value
      and count(*) >= min_timesheets_value
  ),
  employee_stats as (
    select employee, sum(hours) as total_hours, sum(timesheets)::int as total_timesheets, count(*)::int as combo_count, avg(hours) as avg_combo_hours, avg(timesheets) as avg_combo_timesheets
    from employee_combos
    group by employee
  ),
  combo_peer_stats as (
    select jobcode_level1, jobcode_level2, jobcode_level3, service_item, count(*)::int as peer_employee_count, avg(hours) as peer_avg_hours, sum(hours) as peer_total_hours
    from employee_combos
    group by 1, 2, 3, 4
  ),
  scored as (
    select ec.*, es.total_hours, es.total_timesheets, es.combo_count, es.avg_combo_hours, es.avg_combo_timesheets, cps.peer_employee_count, cps.peer_avg_hours, cps.peer_total_hours,
      case when es.total_hours > 0 then ec.hours / es.total_hours else 0 end as employee_hour_share,
      case when es.total_timesheets > 0 then ec.timesheets::numeric / es.total_timesheets else 0 end as employee_timesheet_share
    from employee_combos ec
    join employee_stats es on es.employee = ec.employee
    join combo_peer_stats cps using (jobcode_level1, jobcode_level2, jobcode_level3, service_item)
    where es.combo_count >= 2
  ),
  anomaly_candidates as (
    select *,
      least(10, greatest(0,
        ((max_share_value - least(employee_hour_share, max_share_value)) / max_share_value) * 4
        + ((max_share_value - least(employee_timesheet_share, max_share_value)) / max_share_value) * 3
        + case when timesheets = 1 then 2 else 0 end
        + case when timesheets <= max_timesheets_value then 1 else 0 end
        + case when peer_employee_count = 1 then 0.75 else 0 end
      )) as rarity_score,
      case
        when timesheets = 1 and employee_hour_share <= max_share_value then 'Employee used this job/service combination once'
        when employee_hour_share <= max_share_value and employee_timesheet_share <= max_share_value then 'Very rare job/service combination for this employee'
        when timesheets <= max_timesheets_value then 'Low entry count for this employee'
        else 'Low-share job/service combination for this employee'
      end as reason
    from scored
    where timesheets <= max_timesheets_value
      or employee_hour_share <= max_share_value
      or employee_timesheet_share <= max_share_value
  ),
  anomalies as (
    select *, case when rarity_score >= 7 then 'high' when rarity_score >= 4.5 then 'medium' else 'watch' end as severity
    from anomaly_candidates
  ),
  limited_anomalies as (
    select *
    from anomalies
    order by rarity_score desc, timesheets asc, employee_hour_share asc, hours asc
    limit lim
  ),
  rows_json as (
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
      'last_work', last_work,
      'peer_avg_hours', round(peer_avg_hours::numeric, 2),
      'peer_employee_count', peer_employee_count,
      'employee_hour_share', round((employee_hour_share * 100)::numeric, 2),
      'employee_timesheet_share', round((employee_timesheet_share * 100)::numeric, 2),
      'anomaly_score', round(rarity_score::numeric, 2),
      'severity', severity,
      'reason', reason
    ) order by rarity_score desc, timesheets asc, employee_hour_share asc), '[]'::jsonb) as rows
    from limited_anomalies
  ),
  by_employee as (
    select coalesce(jsonb_agg(jsonb_build_object('employee', employee, 'anomalies', anomaly_count, 'hours', round(hours::numeric, 2), 'max_score', round(max_score::numeric, 2)) order by anomaly_count desc, max_score desc), '[]'::jsonb) as rows
    from (select employee, count(*)::int as anomaly_count, sum(hours) as hours, max(rarity_score) as max_score from anomalies group by employee order by 2 desc, 4 desc limit 15) s
  ),
  by_reason as (
    select coalesce(jsonb_agg(jsonb_build_object('reason', reason, 'count', anomaly_count) order by anomaly_count desc), '[]'::jsonb) as rows
    from (select reason, count(*)::int as anomaly_count from anomalies group by reason order by 2 desc) s
  ),
  by_service_item as (
    select coalesce(jsonb_agg(jsonb_build_object('service_item', service_item, 'anomalies', anomaly_count, 'hours', round(hours::numeric, 2)) order by anomaly_count desc, hours desc), '[]'::jsonb) as rows
    from (select service_item, count(*)::int as anomaly_count, sum(hours) as hours from anomalies group by service_item order by 2 desc, 3 desc limit 15) s
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'filtered_hours', (select coalesce(round(sum(hours)::numeric, 2), 0) from filtered),
      'filtered_timesheets', (select count(*) from filtered),
      'combos_analyzed', (select count(*) from employee_combos),
      'total_anomalies', (select count(*) from anomalies),
      'high_anomalies', (select count(*) from anomalies where severity = 'high'),
      'employees_with_anomalies', (select count(distinct employee) from anomalies),
      'date_start', (select min(work_date) from filtered),
      'date_end', (select max(work_date) from filtered)
    ),
    'anomalies', (select rows from rows_json),
    'by_employee', (select rows from by_employee),
    'by_reason', (select rows from by_reason),
    'by_service_item', (select rows from by_service_item)
  ) into result;

  return result;
end;
$$;

revoke all on function public.refresh_dashboard_experience_records() from public;
revoke all on function public.dashboard_qbtime_filter_options() from public;
revoke all on function public.qbtime_anomaly_detection(text, text, date, date, text, text, text, text, uuid, numeric, integer, integer, numeric, integer) from public;
grant execute on function public.refresh_dashboard_experience_records() to authenticated;
grant execute on function public.dashboard_qbtime_filter_options() to authenticated;
grant execute on function public.qbtime_anomaly_detection(text, text, date, date, text, text, text, text, uuid, numeric, integer, integer, numeric, integer) to authenticated;

select public.refresh_dashboard_experience_records();