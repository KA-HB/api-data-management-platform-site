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
    select
      (r.json_data->>'id')::text as raw_id,
      nullif(r.json_data->>'parent_id', '0') as raw_parent_id,
      coalesce(r.json_data->>'name', r.json_data->>'short_code', r.json_data->>'id') as name
    from public.records r
    join public.datasets d on d.id = r.dataset_id
    where d.name = 'QuickBooks Time Job Codes'
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
      and coalesce(name, '') <> ''
    union
    select distinct jobcode_level1 as id, jobcode_level1 as name
    from public.dashboard_experience_unique_records
    where coalesce(jobcode_level1, '') <> ''
  ),
  level2 as (
    select distinct name as id, name, parent_name as parent_id, parent_name
    from jobcode_paths
    where parent_raw_id is not null
      and grandparent_raw_id is null
      and coalesce(name, '') <> ''
      and coalesce(parent_name, '') <> ''
    union
    select distinct jobcode_level2 as id, jobcode_level2 as name, jobcode_level1 as parent_id, jobcode_level1 as parent_name
    from public.dashboard_experience_unique_records
    where coalesce(jobcode_level2, '') <> ''
      and coalesce(jobcode_level1, '') <> ''
  ),
  level3 as (
    select distinct name as id, name, parent_name as parent_id, parent_name, grandparent_name as grandparent_id, grandparent_name
    from jobcode_paths
    where parent_raw_id is not null
      and grandparent_raw_id is not null
      and coalesce(name, '') <> ''
      and coalesce(parent_name, '') <> ''
      and coalesce(grandparent_name, '') <> ''
    union
    select distinct jobcode_level3 as id, jobcode_level3 as name, jobcode_level2 as parent_id, jobcode_level2 as parent_name, jobcode_level1 as grandparent_id, jobcode_level1 as grandparent_name
    from public.dashboard_experience_unique_records
    where coalesce(jobcode_level3, '') <> ''
      and coalesce(jobcode_level2, '') <> ''
      and coalesce(jobcode_level1, '') <> ''
  ),
  service_items as (
    select distinct service_item as name
    from public.dashboard_experience_unique_records
    where coalesce(service_item, '') <> ''
      and service_item <> 'No service item'
  )
  select jsonb_build_object(
    'employees', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) from employees where coalesce(id, '') <> '' and coalesce(name, '') <> ''),
    'jobcode_level1', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) from level1 where coalesce(name, '') <> ''),
    'jobcode_level2', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id, 'parent_name', parent_name) order by parent_name, name), '[]'::jsonb) from level2 where coalesce(name, '') <> ''),
    'jobcode_level3', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id, 'parent_name', parent_name, 'grandparent_id', grandparent_id, 'grandparent_name', grandparent_name) order by grandparent_name, parent_name, name), '[]'::jsonb) from level3 where coalesce(name, '') <> ''),
    'service_items', (select coalesce(jsonb_agg(name order by name), '[]'::jsonb) from service_items)
  ) into result;

  return result;
end;
$$;

revoke all on function public.dashboard_qbtime_filter_options() from public;
grant execute on function public.dashboard_qbtime_filter_options() to authenticated;
