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

  with employees as (
    select distinct on (employee_id)
      (r.json_data->>'id')::text as employee_id,
      coalesce(
        nullif(trim(concat(r.json_data->>'first_name', ' ', r.json_data->>'last_name')), ''),
        nullif(r.json_data->>'employee_name', ''),
        nullif(r.json_data->>'email', ''),
        nullif(r.json_data->>'username', ''),
        nullif(r.json_data->>'id', '')
      ) as employee_name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where (d.name = 'QuickBooks Time Employees' or d.source_type = 'upload')
      and coalesce(r.json_data->>'id', '') <> ''
      and (r.json_data ? 'first_name' or r.json_data ? 'last_name' or r.json_data ? 'email' or r.json_data ? 'employee_name')
    order by employee_id, r.created_at desc
  ),
  jobcodes as (
    select distinct on (jobcode_id)
      (r.json_data->>'id')::text as jobcode_id,
      nullif(r.json_data->>'parent_id', '0') as parent_id,
      coalesce(nullif(r.json_data->>'name', ''), nullif(r.json_data->>'short_code', ''), r.json_data->>'id') as jobcode_name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where (d.name = 'QuickBooks Time Job Codes' or d.source_type = 'upload')
      and coalesce(r.json_data->>'id', '') <> ''
      and (r.json_data ? 'name' or r.json_data ? 'short_code')
    order by jobcode_id, r.created_at desc
  ),
  job_paths as (
    select
      leaf.jobcode_id,
      coalesce(root.jobcode_id, parent.jobcode_id, leaf.jobcode_id) as level1_id,
      coalesce(root.jobcode_name, parent.jobcode_name, leaf.jobcode_name) as level1_name,
      case when root.jobcode_id is null then null else parent.jobcode_id end as level2_id,
      case when root.jobcode_id is null then null else parent.jobcode_name end as level2_name,
      case when root.jobcode_id is null and parent.jobcode_id is null then null when root.jobcode_id is null then null else leaf.jobcode_id end as level3_id,
      case when root.jobcode_id is null and parent.jobcode_id is null then null when root.jobcode_id is null then null else leaf.jobcode_name end as level3_name,
      leaf.jobcode_name
    from jobcodes leaf
    left join jobcodes parent on parent.jobcode_id = leaf.parent_id
    left join jobcodes root on root.jobcode_id = parent.parent_id
  ),
  timesheets_raw as (
    select
      r.json_data,
      public.safe_date(coalesce(r.json_data->>'date', left(r.json_data->>'start', 10))) as work_date,
      coalesce(nullif(r.json_data #>> '{customfields,53105}', ''), nullif(r.json_data->>'service_item', '')) as service_item,
      r.dataset_id,
      r.created_at,
      r.source_hash
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name <> 'QuickBooks Time PTO'
      and (d.name = 'QuickBooks Time Timesheets' or d.source_type = 'upload')
      and (r.json_data ? 'duration' or r.json_data ? 'hours' or r.json_data ? 'user_id' or r.json_data ? 'employee_name')
      and (dataset_uuid_filter is null or r.dataset_id = dataset_uuid_filter)
  ),
  timesheets as (
    select distinct on (coalesce(json_data->>'id', source_hash, md5(json_data::text)))
      json_data,
      work_date,
      service_item,
      dataset_id
    from timesheets_raw
    order by coalesce(json_data->>'id', source_hash, md5(json_data::text)), created_at desc
  ),
  normalized as (
    select
      t.*,
      coalesce(
        nullif(e.employee_name, ''),
        nullif(t.json_data->>'employee_name', ''),
        nullif(trim(concat(t.json_data->>'first_name', ' ', t.json_data->>'last_name')), ''),
        nullif(t.json_data->>'user_name', ''),
        nullif(t.json_data->>'user_id', ''),
        'Unassigned'
      ) as employee,
      jp.jobcode_name,
      jp.level1_id,
      jp.level1_name,
      jp.level2_id,
      jp.level2_name,
      jp.level3_id,
      jp.level3_name,
      case
        when coalesce(t.json_data->>'duration', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (t.json_data->>'duration')::numeric / 3600
        when coalesce(t.json_data->>'hours', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (t.json_data->>'hours')::numeric
        else 0
      end as hours
    from timesheets t
    left join employees e on e.employee_id = t.json_data->>'user_id'
    left join job_paths jp on jp.jobcode_id = t.json_data->>'jobcode_id'
  ),
  filtered as (
    select *
    from normalized n
    where n.employee !~ '^[0-9]+$'
      and n.employee <> 'Unassigned'
      and n.hours > 0
      and (coalesce(employee_filter, '') = '' or n.json_data->>'user_id' = employee_filter or n.employee ilike '%' || employee_filter || '%')
      and (start_date is null or n.work_date >= start_date)
      and (end_date is null or n.work_date <= end_date)
      and (coalesce(jobcode_level1_filter, '') = '' or n.level1_id = jobcode_level1_filter or n.level1_name ilike '%' || jobcode_level1_filter || '%')
      and (coalesce(jobcode_level2_filter, '') = '' or n.level2_id = jobcode_level2_filter or n.level2_name ilike '%' || jobcode_level2_filter || '%')
      and (coalesce(jobcode_level3_filter, '') = '' or n.level3_id = jobcode_level3_filter or n.level3_name ilike '%' || jobcode_level3_filter || '%')
      and (coalesce(service_item_filter, '') = '' or n.service_item ilike '%' || service_item_filter || '%')
      and (
        coalesce(keyword_filter, '') = ''
        or n.employee ilike '%' || keyword_filter || '%'
        or n.level1_name ilike '%' || keyword_filter || '%'
        or n.level2_name ilike '%' || keyword_filter || '%'
        or n.level3_name ilike '%' || keyword_filter || '%'
        or n.jobcode_name ilike '%' || keyword_filter || '%'
        or n.service_item ilike '%' || keyword_filter || '%'
        or n.json_data->>'notes' ilike '%' || keyword_filter || '%'
      )
  ),
  employee_combos as (
    select
      employee,
      coalesce(level1_name, 'No Job Code 1') as jobcode_level1,
      coalesce(level2_name, 'No Job Code 2') as jobcode_level2,
      coalesce(level3_name, jobcode_name, json_data->>'jobcode_id', 'No Job Code 3') as jobcode_level3,
      coalesce(jobcode_name, json_data->>'jobcode_id', 'No job code') as jobcode,
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
    select
      employee,
      sum(hours) as total_hours,
      sum(timesheets)::int as total_timesheets,
      count(*)::int as combo_count,
      avg(hours) as avg_combo_hours,
      avg(timesheets) as avg_combo_timesheets
    from employee_combos
    group by employee
  ),
  combo_peer_stats as (
    select
      jobcode_level1,
      jobcode_level2,
      jobcode_level3,
      service_item,
      count(*)::int as peer_employee_count,
      avg(hours) as peer_avg_hours,
      sum(hours) as peer_total_hours
    from employee_combos
    group by 1, 2, 3, 4
  ),
  scored as (
    select
      ec.*,
      es.total_hours,
      es.total_timesheets,
      es.combo_count,
      es.avg_combo_hours,
      es.avg_combo_timesheets,
      cps.peer_employee_count,
      cps.peer_avg_hours,
      cps.peer_total_hours,
      case when es.total_hours > 0 then ec.hours / es.total_hours else 0 end as employee_hour_share,
      case when es.total_timesheets > 0 then ec.timesheets::numeric / es.total_timesheets else 0 end as employee_timesheet_share
    from employee_combos ec
    join employee_stats es on es.employee = ec.employee
    join combo_peer_stats cps using (jobcode_level1, jobcode_level2, jobcode_level3, service_item)
    where es.combo_count >= 2
  ),
  anomaly_candidates as (
    select
      *,
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
    select
      *,
      case
        when rarity_score >= 7 then 'high'
        when rarity_score >= 4.5 then 'medium'
        else 'watch'
      end as severity
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
    select coalesce(jsonb_agg(jsonb_build_object(
      'employee', employee,
      'anomalies', anomaly_count,
      'hours', round(hours::numeric, 2),
      'max_score', round(max_score::numeric, 2)
    ) order by anomaly_count desc, max_score desc), '[]'::jsonb) as rows
    from (
      select employee, count(*)::int as anomaly_count, sum(hours) as hours, max(rarity_score) as max_score
      from anomalies
      group by employee
      order by 2 desc, 4 desc
      limit 15
    ) s
  ),
  by_reason as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'reason', reason,
      'count', anomaly_count
    ) order by anomaly_count desc), '[]'::jsonb) as rows
    from (
      select reason, count(*)::int as anomaly_count
      from anomalies
      group by reason
      order by 2 desc
    ) s
  ),
  by_service_item as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'service_item', service_item,
      'anomalies', anomaly_count,
      'hours', round(hours::numeric, 2)
    ) order by anomaly_count desc, hours desc), '[]'::jsonb) as rows
    from (
      select service_item, count(*)::int as anomaly_count, sum(hours) as hours
      from anomalies
      group by service_item
      order by 2 desc, 3 desc
      limit 15
    ) s
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

revoke all on function public.qbtime_anomaly_detection(text, text, date, date, text, text, text, text, uuid, numeric, integer, integer, numeric, integer) from public;
grant execute on function public.qbtime_anomaly_detection(text, text, date, date, text, text, text, text, uuid, numeric, integer, integer, numeric, integer) to authenticated;
