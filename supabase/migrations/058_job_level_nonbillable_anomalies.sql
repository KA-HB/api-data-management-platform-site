-- Flag current non-billable time when the Job Code 1/2 pair is typically billable
-- across the organization, including new employee and service-item combinations.

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
  limit_count integer default 500
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  auth_user_id uuid := auth.uid();
  result jsonb;
  minimum_history integer := greatest(coalesce(min_history_entries, 3), 1);
  row_limit integer := least(greatest(coalesce(limit_count, 500), 10), 2000);
begin
  if auth_user_id is null then raise exception 'Authentication required'; end if;
  if historical_start is null or historical_end is null or current_start is null or current_end is null then
    raise exception 'Historical and current date ranges are required';
  end if;
  if historical_start > historical_end or current_start > current_end then
    raise exception 'A start date cannot be after its end date';
  end if;
  if historical_end >= current_start then
    raise exception 'Historical period must end before the current period starts';
  end if;

  with allowed_datasets as materialized (
    select d.id
    from public.datasets d
    where public.is_admin()
      or exists (
        select 1
        from public.dataset_permissions dp
        where dp.dataset_id = d.id
          and dp.user_id = auth_user_id
      )
  ),
  base as materialized (
    select
      e.record_id,
      e.employee,
      e.employee_id,
      coalesce(nullif(e.employee_id, ''), lower(btrim(e.employee))) as employee_key,
      e.work_date,
      e.hours,
      coalesce(nullif(e.jobcode_level1, ''), 'No Job Code 1') as jobcode_level1,
      coalesce(nullif(e.jobcode_level2, ''), 'No Job Code 2') as jobcode_level2,
      coalesce(nullif(e.jobcode_level3, ''), 'No Job Code 3') as jobcode_level3,
      coalesce(nullif(e.service_item, ''), 'No service item') as service_item,
      lower(btrim(coalesce(e.json_data #>> '{customfields,53103}', e.json_data->>'billable', ''))) in ('yes', 'true', '1') as is_billable,
      e.json_data ? 'approved' or e.json_data ? 'approved_status' as has_approval_metadata,
      lower(btrim(coalesce(e.json_data->>'approved_status', e.json_data->>'approved', ''))) as approval_status,
      case
        when lower(btrim(coalesce(e.jobcode_level1, ''))) in (
          'fringe', 'overhead', 'z-cobra payment', 'z-cobra payments', 'holiday', 'sick',
          'pto', 'unpaid time off', 'vacation', 'vaction'
        ) then 'Excluded Job Code 1 category'
        when coalesce(e.jobcode_level2, '') ~* '^(oh-|ohd-)' then 'Excluded OH-/OHD- structural Job Code 2'
        else null
      end as excluded_reason
    from public.dashboard_experience_unique_records e
    join allowed_datasets d on d.id = e.dataset_id
    where e.employee <> 'Unassigned'
      and e.hours > 0
      and e.work_date between historical_start and current_end
      and (coalesce(jobcode_level1_filter, '') = '' or e.jobcode_level1 ilike '%' || btrim(jobcode_level1_filter) || '%')
      and (coalesce(jobcode_level2_filter, '') = '' or e.jobcode_level2 ilike '%' || btrim(jobcode_level2_filter) || '%')
  ),
  historical_all as materialized (
    select * from base
    where work_date between historical_start and historical_end
      and excluded_reason is null
      and (not has_approval_metadata or approval_status like '%approved%' or approval_status in ('yes', 'true', '1'))
  ),
  historical_job_overall as (
    select jobcode_level1, jobcode_level2,
      count(*)::integer as job_overall_history_entries,
      sum(hours) as job_overall_history_hours,
      coalesce(sum(hours) filter (where is_billable), 0) as job_overall_billable_hours
    from historical_all
    group by 1, 2
  ),
  historical_job as (
    select employee_key, jobcode_level1, jobcode_level2,
      count(*)::integer as job_history_entries,
      sum(hours) as job_history_hours,
      coalesce(sum(hours) filter (where is_billable), 0) as job_history_billable_hours
    from historical_all
    group by 1, 2, 3
  ),
  historical_combo as (
    select employee_key, jobcode_level1, jobcode_level2, service_item,
      count(*)::integer as history_entries,
      sum(hours) as history_hours,
      coalesce(sum(hours) filter (where is_billable), 0) as history_billable_hours
    from historical_all
    where coalesce(service_item_filter, '') = '' or service_item ilike '%' || btrim(service_item_filter) || '%'
    group by 1, 2, 3, 4
  ),
  current_grouped as (
    select employee, employee_id, employee_key, jobcode_level1, jobcode_level2, jobcode_level3,
      service_item, is_billable, excluded_reason,
      sum(hours) as current_hours,
      count(*)::integer as current_entries,
      min(work_date) as first_work,
      max(work_date) as last_work
    from base
    where work_date between current_start and current_end
      and (
        coalesce(btrim(employee_filter), '') = ''
        or lower(coalesce(employee_id, '')) = lower(btrim(employee_filter))
        or employee ilike '%' || btrim(employee_filter) || '%'
      )
      and (coalesce(service_item_filter, '') = '' or service_item ilike '%' || btrim(service_item_filter) || '%')
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9
  ),
  evaluated as (
    select c.*,
      hjo.job_overall_history_entries, hjo.job_overall_history_hours, hjo.job_overall_billable_hours,
      hj.job_history_entries, hj.job_history_hours, hj.job_history_billable_hours,
      hc.history_entries, hc.history_hours, hc.history_billable_hours,
      case when coalesce(hjo.job_overall_history_hours, 0) > 0
        then coalesce(hjo.job_overall_billable_hours, 0) / hjo.job_overall_history_hours end as job_overall_billable_rate,
      case when coalesce(hj.job_history_hours, 0) > 0
        then coalesce(hj.job_history_billable_hours, 0) / hj.job_history_hours end as job_billable_rate,
      case when coalesce(hc.history_hours, 0) > 0
        then coalesce(hc.history_billable_hours, 0) / hc.history_hours end as combo_billable_rate
    from current_grouped c
    left join historical_job_overall hjo using (jobcode_level1, jobcode_level2)
    left join historical_job hj using (employee_key, jobcode_level1, jobcode_level2)
    left join historical_combo hc using (employee_key, jobcode_level1, jobcode_level2, service_item)
  ),
  classified as (
    select e.*,
      case
        when excluded_reason is not null then 'excluded_code'
        when job_overall_history_entries >= minimum_history and job_overall_billable_rate >= 0.95 and not is_billable
          then 'typically_billable_job_nonbillable'
        when job_history_entries is null then 'new_job_code'
        when history_entries is null then 'service_mismatch'
        when combo_billable_rate >= 0.95 and not is_billable then 'incorrect_nonbillable'
        when combo_billable_rate <= 0.05 and is_billable then 'incorrect_billable'
        when history_entries < minimum_history then 'rare_pattern'
        else 'correct'
      end as result_code,
      case
        when excluded_reason is not null then 'Excluded Code'
        when job_overall_history_entries >= minimum_history and job_overall_billable_rate >= 0.95 and not is_billable
          then 'Non-billable Risk'
        when job_history_entries is null then 'New Job Code'
        when history_entries is null then 'Service Mismatch'
        when combo_billable_rate >= 0.95 and not is_billable then 'Incorrect'
        when combo_billable_rate <= 0.05 and is_billable then 'Incorrect'
        when history_entries < minimum_history then 'Rare Pattern'
        else 'Correct'
      end as result_label,
      case
        when excluded_reason is not null then 'ok'
        when job_overall_history_entries >= minimum_history and job_overall_billable_rate >= 0.95 and not is_billable then 'high'
        when (combo_billable_rate >= 0.95 and not is_billable) or (combo_billable_rate <= 0.05 and is_billable) then 'high'
        when job_history_entries is null or history_entries is null then 'medium'
        when history_entries < minimum_history then 'watch'
        else 'ok'
      end as severity,
      case
        when excluded_reason is not null then excluded_reason
        when job_overall_history_entries >= minimum_history and job_overall_billable_rate >= 0.95 and not is_billable
          then format('This job was %s%% billable across %s approved historical entries, but current time is marked No', round(job_overall_billable_rate * 100, 1), job_overall_history_entries)
        when job_history_entries is null then 'Employee has no approved history for this Job Code 1 and Job Code 2 combination'
        when history_entries is null then format('Job is known, but this service item is new; employee job history is %s%% billable', round(job_billable_rate * 100, 1))
        when combo_billable_rate >= 0.95 and not is_billable then format('Historically %s%% billable for this employee and service, but current time is marked No', round(combo_billable_rate * 100, 1))
        when combo_billable_rate <= 0.05 and is_billable then format('Historically %s%% billable for this employee and service, but current time is marked Yes', round(combo_billable_rate * 100, 1))
        when history_entries < minimum_history then format('Only %s approved historical entries for this employee, job, and service combination', history_entries)
        else 'Current billing choice matches the employee''s approved historical pattern'
      end as reason
    from evaluated e
  ),
  findings as (
    select * from classified where result_code not in ('correct', 'excluded_code')
  ),
  job_risk as (
    select * from classified where result_code = 'typically_billable_job_nonbillable'
  ),
  limited_rows as (
    select * from classified
    order by case severity when 'high' then 1 when 'medium' then 2 when 'watch' then 3 else 4 end,
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
      'job_overall_historical_billable_pct', case when job_overall_billable_rate is null then null else round((job_overall_billable_rate * 100)::numeric, 2) end,
      'job_overall_historical_hours', case when job_overall_history_hours is null then null else round(job_overall_history_hours::numeric, 2) end,
      'job_overall_historical_entries', job_overall_history_entries,
      'historical_billable_pct', case when combo_billable_rate is null then null else round((combo_billable_rate * 100)::numeric, 2) end,
      'job_historical_billable_pct', case when job_billable_rate is null then null else round((job_billable_rate * 100)::numeric, 2) end,
      'historical_hours', case when history_hours is null then null else round(history_hours::numeric, 2) end,
      'historical_entries', history_entries, 'first_work', first_work, 'last_work', last_work
    ) order by case severity when 'high' then 1 when 'medium' then 2 when 'watch' then 3 else 4 end,
      current_hours desc, employee), '[]'::jsonb) as rows
    from limited_rows
  ),
  by_result as (
    select coalesce(jsonb_agg(jsonb_build_object('result', result_label, 'count', result_count)
      order by result_count desc, result_label), '[]'::jsonb) as rows
    from (select result_label, count(*)::integer as result_count from classified group by result_label) s
  ),
  by_employee as (
    select coalesce(jsonb_agg(jsonb_build_object('employee', employee, 'findings', finding_count, 'hours', round(hours::numeric, 2))
      order by finding_count desc, hours desc), '[]'::jsonb) as rows
    from (
      select employee, count(*)::integer as finding_count, sum(current_hours) as hours
      from findings group by employee order by 2 desc, 3 desc limit 20
    ) s
  ),
  nonbillable_by_job as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'job', jobcode_level1 || ' / ' || jobcode_level2,
      'jobcode_level1', jobcode_level1,
      'jobcode_level2', jobcode_level2,
      'nonbillable_hours', round(nonbillable_hours::numeric, 2),
      'nonbillable_entries', nonbillable_entries,
      'employees', employees,
      'historical_billable_pct', round((historical_billable_rate * 100)::numeric, 2)
    ) order by nonbillable_hours desc, jobcode_level1, jobcode_level2), '[]'::jsonb) as rows
    from (
      select jobcode_level1, jobcode_level2,
        sum(current_hours) as nonbillable_hours,
        sum(current_entries)::integer as nonbillable_entries,
        count(distinct employee_key)::integer as employees,
        max(job_overall_billable_rate) as historical_billable_rate
      from job_risk
      group by 1, 2
      order by 3 desc
      limit 30
    ) s
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'findings', (select count(*) from findings),
      'high_findings', (select count(*) from findings where severity = 'high'),
      'employees_flagged', (select count(distinct employee_key) from findings),
      'current_combinations', (select count(*) from classified),
      'current_entries', (select coalesce(sum(current_entries), 0) from classified),
      'current_hours', (select coalesce(round(sum(current_hours)::numeric, 2), 0) from classified),
      'typically_billable_nonbillable_findings', (select count(*) from job_risk),
      'typically_billable_nonbillable_hours', (select coalesce(round(sum(current_hours)::numeric, 2), 0) from job_risk),
      'typically_billable_nonbillable_entries', (select coalesce(sum(current_entries), 0) from job_risk),
      'typically_billable_jobs_affected', (select count(distinct (jobcode_level1, jobcode_level2)) from job_risk),
      'correct_combinations', (select count(*) from classified where result_code = 'correct'),
      'excluded_combinations', (select count(*) from classified where result_code = 'excluded_code'),
      'new_job_codes', (select count(*) from classified where result_code = 'new_job_code'),
      'service_mismatches', (select count(*) from classified where result_code = 'service_mismatch'),
      'rare_patterns', (select count(*) from classified where result_code = 'rare_pattern'),
      'rows_returned', (select count(*) from limited_rows),
      'is_truncated', (select count(*) from classified) > row_limit,
      'approval_metadata_entries', (select count(*) from base where work_date between historical_start and historical_end and has_approval_metadata),
      'historical_start', historical_start, 'historical_end', historical_end,
      'current_start', current_start, 'current_end', current_end
    ),
    'audit_rows', (select rows from rows_json),
    'by_result', (select rows from by_result),
    'by_employee', (select rows from by_employee),
    'nonbillable_by_job', (select rows from nonbillable_by_job),
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

notify pgrst, 'reload schema';
