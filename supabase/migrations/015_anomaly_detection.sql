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
  min_hours numeric default 2,
  min_timesheets integer default 1,
  limit_count integer default 100
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
  min_hours_value numeric := greatest(coalesce(min_hours, 2), 0);
  min_timesheets_value integer := greatest(coalesce(min_timesheets, 1), 1);
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
      avg(hours) as avg_combo_hours,
      stddev_pop(hours) as stddev_combo_hours,
      count(*)::int as combo_count
    from employee_combos
    group by employee
  ),
  peer_stats as (
    select
      jobcode_level1,
      jobcode_level2,
      jobcode_level3,
      service_item,
      avg(hours) as peer_avg_hours,
      stddev_pop(hours) as peer_stddev_hours,
      count(*)::int as peer_employee_count
    from employee_combos
    group by 1, 2, 3, 4
  ),
  scored as (
    select
      ec.*,
      es.total_hours,
      es.avg_combo_hours,
      es.combo_count,
      ps.peer_avg_hours,
      ps.peer_employee_count,
      case when coalesce(ps.peer_stddev_hours, 0) > 0 then abs((ec.hours - ps.peer_avg_hours) / ps.peer_stddev_hours) else 0 end as peer_z_score,
      case when coalesce(es.stddev_combo_hours, 0) > 0 then abs((ec.hours - es.avg_combo_hours) / es.stddev_combo_hours) else 0 end as employee_z_score
    from employee_combos ec
    join employee_stats es on es.employee = ec.employee
    join peer_stats ps using (jobcode_level1, jobcode_level2, jobcode_level3, service_item)
  ),
  anomaly_candidates as (
    select
      *,
      greatest(
        peer_z_score,
        employee_z_score,
        case when peer_employee_count = 1 and hours >= greatest(min_hours_value, 8) then 2.25 else 0 end
      ) as anomaly_score,
      case
        when peer_employee_count = 1 and hours >= greatest(min_hours_value, 8) then 'Rare job/service combination'
        when peer_z_score >= 2 and hours > peer_avg_hours then 'Hours far above peers for this job/service combination'
        when peer_z_score >= 2 and hours < peer_avg_hours then 'Hours far below peers for this job/service combination'
        when employee_z_score >= 2 and hours > avg_combo_hours then 'Unusually concentrated employee experience'
        when employee_z_score >= 2 and hours < avg_combo_hours then 'Unusually light employee experience'
        else 'Notable pattern'
      end as reason
    from scored
    where peer_z_score >= 1.8
      or employee_z_score >= 1.8
      or (peer_employee_count = 1 and hours >= greatest(min_hours_value, 8))
  ),
  anomalies as (
    select
      *,
      case
        when anomaly_score >= 3 then 'high'
        when anomaly_score >= 2.25 then 'medium'
        else 'watch'
      end as severity
    from anomaly_candidates
  ),
  limited_anomalies as (
    select *
    from anomalies
    order by anomaly_score desc, hours desc
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
      'peer_z_score', round(peer_z_score::numeric, 2),
      'employee_z_score', round(employee_z_score::numeric, 2),
      'anomaly_score', round(anomaly_score::numeric, 2),
      'severity', severity,
      'reason', reason
    ) order by anomaly_score desc, hours desc), '[]'::jsonb) as rows
    from limited_anomalies
  ),
  by_employee as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'employee', employee,
      'anomalies', anomaly_count,
      'hours', round(hours::numeric, 2),
      'max_score', round(max_score::numeric, 2)
    ) order by anomaly_count desc, hours desc), '[]'::jsonb) as rows
    from (
      select employee, count(*)::int as anomaly_count, sum(hours) as hours, max(anomaly_score) as max_score
      from anomalies
      group by employee
      order by 2 desc, 3 desc
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

revoke all on function public.qbtime_anomaly_detection(text, text, date, date, text, text, text, text, uuid, numeric, integer, integer) from public;
grant execute on function public.qbtime_anomaly_detection(text, text, date, date, text, text, text, text, uuid, numeric, integer, integer) to authenticated;
