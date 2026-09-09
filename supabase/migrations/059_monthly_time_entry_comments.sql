-- Individual QuickBooks Time entries and their Notes for monthly-report drill-downs and exports.

create or replace function public.monthly_time_entry_details(
  p_report_month date,
  p_selected_jobcode_level1 text,
  p_selected_jobcode_level2 text,
  p_selected_employee_id text default null,
  p_selected_service_item text default null,
  p_selected_is_billable boolean default null
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
  month_start date := date_trunc('month', coalesce(p_report_month, current_date - interval '1 month'))::date;
  next_month date := (date_trunc('month', coalesce(p_report_month, current_date - interval '1 month')) + interval '1 month')::date;
begin
  if auth_user_id is null then
    raise exception 'Authentication required';
  end if;

  if coalesce(btrim(p_selected_jobcode_level1), '') = '' or coalesce(btrim(p_selected_jobcode_level2), '') = '' then
    raise exception 'Job Code 1 and Job Code 2 are required';
  end if;

  with recursive allowed_datasets as (
    select d.id
    from public.datasets d
    where d.name = 'QuickBooks Time Timesheets'
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
  latest_employees as (
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
    order by r.json_data->>'id', r.created_at desc
  ),
  latest_jobcodes as (
    select distinct on (r.json_data->>'id')
      r.json_data->>'id' as id,
      nullif(r.json_data->>'parent_id', '0') as parent_id,
      coalesce(nullif(btrim(r.json_data->>'name'), ''), nullif(btrim(r.json_data->>'short_code'), ''), 'Unassigned') as name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Job Codes'
      and nullif(r.json_data->>'id', '') is not null
    order by r.json_data->>'id', r.created_at desc
  ),
  jobcode_paths as (
    select j.id as leaf_id, j.parent_id, 0 as depth, array[j.name]::text[] as path
    from latest_jobcodes j
    union all
    select p.leaf_id, parent.parent_id, p.depth + 1, array_prepend(parent.name, p.path)
    from jobcode_paths p
    join latest_jobcodes parent on parent.id = p.parent_id
    where p.depth < 12
  ),
  resolved_jobcodes as (
    select distinct on (leaf_id)
      leaf_id,
      coalesce(nullif(btrim(path[1]), ''), 'Unassigned') as jobcode_level1,
      coalesce(nullif(btrim(path[2]), ''), 'Not specified') as jobcode_level2
    from jobcode_paths
    order by leaf_id, depth desc
  ),
  timesheet_base as materialized (
    select
      r.id as record_id,
      r.json_data,
      r.work_date,
      coalesce(r.duration_seconds, 0) / 3600.0 as hours,
      string_to_array(coalesce(nullif(r.json_data #>> '{customfields,53105}', ''), ''), ':') as service_parts
    from public.records r
    join allowed_datasets d on d.id = r.dataset_id
    where r.work_date >= month_start
      and r.work_date < next_month
      and coalesce(r.duration_seconds, 0) > 0
  ),
  monthly_entries as materialized (
    select
      coalesce(t.json_data->>'id', t.record_id::text) as entry_id,
      coalesce(j.jobcode_level1, 'Unassigned') as jobcode_level1,
      coalesce(j.jobcode_level2, 'Not specified') as jobcode_level2,
      coalesce(t.json_data->>'user_id', '') as employee_id,
      coalesce(
        e.employee_name,
        public.clean_employee_label(t.json_data->>'employee_name'),
        public.clean_employee_label(t.json_data->>'username'),
        'Employee ' || coalesce(t.json_data->>'user_id', 'unknown')
      ) as employee,
      coalesce(
        public.clean_jobcode_label(nullif(btrim(t.service_parts[array_length(t.service_parts, 1)]), '')),
        public.clean_jobcode_label(t.json_data->>'service item'),
        public.clean_jobcode_label(t.json_data->>'service_item'),
        'No service item'
      ) as service_item,
      lower(btrim(coalesce(t.json_data #>> '{customfields,53103}', ''))) in ('yes', 'true', '1') as is_billable,
      t.work_date,
      t.json_data->>'start' as start_time,
      t.hours,
      coalesce(nullif(btrim(t.json_data->>'notes'), ''), '') as comment
    from timesheet_base t
    left join resolved_jobcodes j on j.leaf_id = t.json_data->>'jobcode_id'
    left join latest_employees e on e.employee_id = t.json_data->>'user_id'
  ),
  selected_entries as materialized (
    select *
    from monthly_entries e
    where e.jobcode_level1 = p_selected_jobcode_level1
      and e.jobcode_level2 = p_selected_jobcode_level2
      and (p_selected_employee_id is null or e.employee_id = p_selected_employee_id)
      and (nullif(btrim(p_selected_service_item), '') is null or e.service_item = p_selected_service_item)
      and (p_selected_is_billable is null or e.is_billable = p_selected_is_billable)
  ),
  totals as (
    select
      count(*)::integer as entry_count,
      coalesce(round(sum(hours)::numeric, 2), 0) as hours,
      count(*) filter (where comment <> '')::integer as entries_with_comments
    from selected_entries
  )
  select jsonb_build_object(
    'month_start', month_start,
    'month_end', next_month - 1,
    'jobcode_level1', p_selected_jobcode_level1,
    'jobcode_level2', p_selected_jobcode_level2,
    'summary', jsonb_build_object(
      'entry_count', t.entry_count,
      'hours', t.hours,
      'entries_with_comments', t.entries_with_comments
    ),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.work_date desc, e.employee, e.start_time, e.entry_id)
      from selected_entries e
    ), '[]'::jsonb)
  )
  into result
  from totals t;

  return result;
end;
$$;

revoke all on function public.monthly_time_entry_details(date, text, text, text, text, boolean) from public;
revoke all on function public.monthly_time_entry_details(date, text, text, text, text, boolean) from anon;
grant execute on function public.monthly_time_entry_details(date, text, text, text, text, boolean) to authenticated;

