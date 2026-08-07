-- Compare current QuickBooks Time billing choices with each employee's approved history.

create or replace function public.qbtime_billing_behavior_audit(
  historical_start date,
  historical_end date,
  current_start date,
  current_end date,
  employee_filter text default null,
  jobcode_level1_filter text default null,
  jobcode_level2_filter text default null,
  service_item_filter text default null,
  min_history_entries integer default 3,
  limit_count integer default 250
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  minimum_history integer := greatest(coalesce(min_history_entries, 3), 1);
  row_limit integer := least(greatest(coalesce(limit_count, 250), 10), 500);
  excluded_pattern text := '(^|[[:space:]_:/-])(fringe|overhead|z[[:space:]-]*cobra([[:space:]-]*payments?)?|holiday|sick|pto|unpaid[[:space:]-]*time[[:space:]-]*off|vacation|vaction)($|[[:space:]_:/-])';
begin
  if not public.is_admin() then raise exception 'Admin role required'; end if;
  if historical_start is null or historical_end is null or current_start is null or current_end is null then
    raise exception 'Historical and current date ranges are required';
  end if;
  if historical_start > historical_end or current_start > current_end then
    raise exception 'A start date cannot be after its end date';
  end if;
  if historical_end >= current_start then
    raise exception 'Historical period must end before the current period starts';
  end if;

  with base as materialized (
    select
      e.record_id, e.employee, e.employee_id, e.work_date, e.hours,
      coalesce(nullif(e.jobcode_level1, ''), 'No Job Code 1') as jobcode_level1,
      coalesce(nullif(e.jobcode_level2, ''), 'No Job Code 2') as jobcode_level2,
      coalesce(nullif(e.jobcode_level3, ''), 'No Job Code 3') as jobcode_level3,
      coalesce(nullif(e.service_item, ''), 'No service item') as service_item,
      lower(btrim(coalesce(e.json_data #>> '{customfields,53103}', ''))) in ('yes', 'true', '1') as is_billable,
      e.json_data ? 'approved' or e.json_data ? 'approved_status' as has_approval_metadata,
      lower(btrim(coalesce(e.json_data->>'approved_status', e.json_data->>'approved', ''))) as approval_status
    from public.dashboard_experience_unique_records e
    where e.employee <> 'Unassigned'
      and e.hours > 0
      and e.work_date between historical_start and current_end
      and (
        coalesce(btrim(employee_filter), '') = ''
        or lower(coalesce(e.employee_id, '')) = lower(btrim(employee_filter))
        or e.employee ilike '%' || btrim(employee_filter) || '%'
      )
      and (coalesce(jobcode_level1_filter, '') = '' or e.jobcode_level1 ilike '%' || jobcode_level1_filter || '%')
      and (coalesce(jobcode_level2_filter, '') = '' or e.jobcode_level2 ilike '%' || jobcode_level2_filter || '%')
  ),
  eligible as materialized (
    select * from base
    where concat_ws(' / ', jobcode_level1, jobcode_level2, jobcode_level3, service_item) !~* excluded_pattern
      and jobcode_level2 !~* '^(oh-|ohd-)'
  ),
  historical_all as materialized (
    select * from eligible
    where work_date between historical_start and historical_end
      and (not has_approval_metadata or approval_status in ('approved', 'yes', 'true', '1'))
  ),
  historical_job as (
    select employee_id, jobcode_level1, jobcode_level2,
      count(*)::integer as job_history_entries,
      sum(hours) as job_history_hours,
      sum(hours) filter (where is_billable) as job_history_billable_hours
    from historical_all
    group by 1, 2, 3
  ),
  historical_combo as (
    select employee_id, jobcode_level1, jobcode_level2, service_item,
      count(*)::integer as history_entries,
      sum(hours) as history_hours,
      sum(hours) filter (where is_billable) as history_billable_hours
    from historical_all
    where coalesce(service_item_filter, '') = '' or service_item ilike '%' || service_item_filter || '%'
    group by 1, 2, 3, 4
  ),
  current_grouped as (
    select employee, employee_id, jobcode_level1, jobcode_level2, jobcode_level3, service_item, is_billable,
      sum(hours) as current_hours,
      count(*)::integer as current_entries,
      min(work_date) as first_work,
      max(work_date) as last_work
    from eligible
    where work_date between current_start and current_end
      and (coalesce(service_item_filter, '') = '' or service_item ilike '%' || service_item_filter || '%')
    group by 1, 2, 3, 4, 5, 6, 7
  ),
  evaluated as (
    select c.*, hj.job_history_entries, hj.job_history_hours, hj.job_history_billable_hours,
      hc.history_entries, hc.history_hours, hc.history_billable_hours,
      case when coalesce(hj.job_history_hours, 0) > 0 then hj.job_history_billable_hours / hj.job_history_hours end as job_billable_rate,
      case when coalesce(hc.history_hours, 0) > 0 then hc.history_billable_hours / hc.history_hours end as combo_billable_rate
    from current_grouped c
    left join historical_job hj using (employee_id, jobcode_level1, jobcode_level2)
    left join historical_combo hc using (employee_id, jobcode_level1, jobcode_level2, service_item)
  ),
  classified as (
    select e.*,
      case
        when job_history_entries is null then 'new_job_code'
        when history_entries is null then 'service_mismatch'
        when combo_billable_rate >= 0.95 and not is_billable then 'incorrect_nonbillable'
        when combo_billable_rate <= 0.05 and is_billable then 'incorrect_billable'
        when history_entries < minimum_history then 'rare_pattern'
        else 'correct'
      end as result_code,
      case
        when job_history_entries is null then 'New Job Code'
        when history_entries is null then 'Service Mismatch'
        when combo_billable_rate >= 0.95 and not is_billable then 'Incorrect'
        when combo_billable_rate <= 0.05 and is_billable then 'Incorrect'
        when history_entries < minimum_history then 'Rare Pattern'
        else 'Correct'
      end as result_label,
      case
        when (combo_billable_rate >= 0.95 and not is_billable) or (combo_billable_rate <= 0.05 and is_billable) then 'high'
        when job_history_entries is null or history_entries is null then 'medium'
        when history_entries < minimum_history then 'watch'
        else 'ok'
      end as severity,
      case
        when job_history_entries is null then 'Employee has no history for this Job Code 1 and Job Code 2 combination'
        when history_entries is null then format('Job is known, but this service item is new; job history is %s%% billable', round(job_billable_rate * 100, 1))
        when combo_billable_rate >= 0.95 and not is_billable then format('Historically %s%% billable, but current entry is marked No', round(combo_billable_rate * 100, 1))
        when combo_billable_rate <= 0.05 and is_billable then format('Historically %s%% billable, but current entry is marked Yes', round(combo_billable_rate * 100, 1))
        when history_entries < minimum_history then format('Only %s historical entries for this employee, job, and service combination', history_entries)
        else 'Current billing choice matches the employee''s historical pattern'
      end as reason
    from evaluated e
  ),
  findings as (
    select * from classified where result_code <> 'correct'
  ),
  limited_findings as (
    select * from findings
    order by case severity when 'high' then 1 when 'medium' then 2 else 3 end,
      current_hours desc, employee, jobcode_level1, jobcode_level2, service_item
    limit row_limit
  ),
  rows_json as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'result_code', result_code, 'result', result_label, 'severity', severity,
      'employee', employee, 'reason', reason,
      'jobcode_level1', jobcode_level1, 'jobcode_level2', jobcode_level2, 'jobcode_level3', jobcode_level3,
      'service_item', service_item, 'current_billable', case when is_billable then 'Yes' else 'No' end,
      'current_hours', round(current_hours::numeric, 2), 'current_entries', current_entries,
      'historical_billable_pct', round((combo_billable_rate * 100)::numeric, 2),
      'job_historical_billable_pct', round((job_billable_rate * 100)::numeric, 2),
      'historical_hours', round(history_hours::numeric, 2), 'historical_entries', history_entries,
      'first_work', first_work, 'last_work', last_work
    ) order by case severity when 'high' then 1 when 'medium' then 2 else 3 end, current_hours desc, employee), '[]'::jsonb) as rows
    from limited_findings
  ),
  by_result as (
    select coalesce(jsonb_agg(jsonb_build_object('result', result_label, 'count', finding_count) order by finding_count desc, result_label), '[]'::jsonb) as rows
    from (select result_label, count(*)::integer as finding_count from findings group by result_label) s
  ),
  by_employee as (
    select coalesce(jsonb_agg(jsonb_build_object('employee', employee, 'findings', finding_count, 'hours', round(hours::numeric, 2)) order by finding_count desc, hours desc), '[]'::jsonb) as rows
    from (
      select employee, count(*)::integer as finding_count, sum(current_hours) as hours
      from findings group by employee order by 2 desc, 3 desc limit 15
    ) s
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'findings', (select count(*) from findings),
      'high_findings', (select count(*) from findings where severity = 'high'),
      'employees_flagged', (select count(distinct employee_id) from findings),
      'current_combinations', (select count(*) from classified),
      'current_entries', (select coalesce(sum(current_entries), 0) from classified),
      'current_hours', (select coalesce(round(sum(current_hours)::numeric, 2), 0) from classified),
      'correct_combinations', (select count(*) from classified where result_code = 'correct'),
      'approval_metadata_entries', (select count(*) from base where work_date between historical_start and historical_end and has_approval_metadata),
      'historical_start', historical_start, 'historical_end', historical_end,
      'current_start', current_start, 'current_end', current_end
    ),
    'findings', (select rows from rows_json),
    'by_result', (select rows from by_result),
    'by_employee', (select rows from by_employee),
    'excluded_categories', jsonb_build_array(
      'Fringe', 'Overhead', 'Z-Cobra Payments', 'Holiday', 'Sick',
      'PTO', 'Unpaid Time Off', 'Vacation', 'OH- and OHD- structural codes'
    )
  ) into result;

  return result;
end;
$$;

revoke all on function public.qbtime_billing_behavior_audit(date, date, date, date, text, text, text, text, integer, integer) from public;
revoke all on function public.qbtime_billing_behavior_audit(date, date, date, date, text, text, text, text, integer, integer) from anon;
grant execute on function public.qbtime_billing_behavior_audit(date, date, date, date, text, text, text, text, integer, integer) to authenticated;
