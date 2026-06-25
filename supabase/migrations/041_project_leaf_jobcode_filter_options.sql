-- Make dashboard job-code dropdowns match the proposal/operations workflow.
-- Job Code 1 is the used project/job leaf code from QuickBooks Time, not just the broad parent bucket.
-- Administrative/non-experience codes are excluded from filter options.

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
    where public.clean_jobcode_label(leaf.name) is not null
  ),
  used_jobcodes as (
    select distinct nullif(json_data->>'jobcode_id', '') as raw_id
    from scoped
    where nullif(json_data->>'jobcode_id', '') is not null
  ),
  used_paths as (
    select distinct p.*
    from jobcode_paths p
    join used_jobcodes u on u.raw_id = p.raw_id
  ),
  level1 as (
    select distinct name as id, name
    from used_paths
    where public.clean_jobcode_label(name) is not null
    union
    select distinct jobcode as id, jobcode as name
    from scoped
    where public.clean_jobcode_label(jobcode) is not null
  ),
  level2 as (
    select distinct
      coalesce(parent_name, grandparent_name) as id,
      coalesce(parent_name, grandparent_name) as name,
      name as parent_id,
      name as parent_name
    from used_paths
    where public.clean_jobcode_label(name) is not null
      and public.clean_jobcode_label(coalesce(parent_name, grandparent_name)) is not null
    union
    select distinct jobcode_level2 as id, jobcode_level2 as name, jobcode as parent_id, jobcode as parent_name
    from scoped
    where public.clean_jobcode_label(jobcode_level2) is not null
      and public.clean_jobcode_label(jobcode) is not null
  ),
  level3 as (
    select distinct
      grandparent_name as id,
      grandparent_name as name,
      coalesce(parent_name, name) as parent_id,
      coalesce(parent_name, name) as parent_name,
      name as grandparent_id,
      name as grandparent_name
    from used_paths
    where public.clean_jobcode_label(name) is not null
      and public.clean_jobcode_label(parent_name) is not null
      and public.clean_jobcode_label(grandparent_name) is not null
    union
    select distinct jobcode_level3 as id, jobcode_level3 as name, jobcode_level2 as parent_id, jobcode_level2 as parent_name, jobcode as grandparent_id, jobcode as grandparent_name
    from scoped
    where public.clean_jobcode_label(jobcode_level3) is not null
      and public.clean_jobcode_label(jobcode_level2) is not null
      and public.clean_jobcode_label(jobcode) is not null
  ),
  service_items as (
    select distinct service_item as name
    from scoped
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

revoke all on function public.dashboard_qbtime_filter_options() from public;
revoke all on function public.dashboard_qbtime_filter_options() from anon;
grant execute on function public.dashboard_qbtime_filter_options() to authenticated;

select public.grant_shared_qbtime_dataset_permissions(null);
select public.refresh_dashboard_experience_records();