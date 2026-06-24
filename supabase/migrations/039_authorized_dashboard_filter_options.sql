-- Let regular users populate dashboard lookup dropdowns from datasets they are
-- authorized to see. Admins still receive options across all datasets.

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

  with scoped as materialized (
    select *
    from public.dashboard_experience_unique_records e
    where e.employee <> 'Unassigned'
      and e.hours > 0
      and (
        is_admin_user
        or exists (
          select 1
          from public.dataset_permissions dp
          where dp.dataset_id = e.dataset_id
            and dp.user_id = auth_user_id
        )
      )
  ),
  employees as (
    select distinct employee_id as id, employee as name
    from scoped
    where public.clean_employee_label(employee) is not null
  ),
  level1 as (
    select distinct jobcode_level1 as id, jobcode_level1 as name
    from scoped
    where public.clean_jobcode_label(jobcode_level1) is not null
  ),
  level2 as (
    select distinct jobcode_level2 as id, jobcode_level2 as name, jobcode_level1 as parent_id, jobcode_level1 as parent_name
    from scoped
    where public.clean_jobcode_label(jobcode_level2) is not null
      and public.clean_jobcode_label(jobcode_level1) is not null
  ),
  level3 as (
    select distinct jobcode_level3 as id, jobcode_level3 as name, jobcode_level2 as parent_id, jobcode_level2 as parent_name, jobcode_level1 as grandparent_id, jobcode_level1 as grandparent_name
    from scoped
    where public.clean_jobcode_label(jobcode_level3) is not null
      and public.clean_jobcode_label(jobcode_level2) is not null
      and public.clean_jobcode_label(jobcode_level1) is not null
  ),
  service_items as (
    select distinct service_item as name
    from scoped
    where coalesce(service_item, '') <> ''
      and service_item <> 'No service item'
  )
  select jsonb_build_object(
    'employees',
      (
        select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb)
        from employees
        where coalesce(id, '') <> ''
          and coalesce(name, '') <> ''
      ),
    'jobcode_level1',
      (
        select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb)
        from level1
      ),
    'jobcode_level2',
      (
        select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id, 'parent_name', parent_name) order by parent_name, name), '[]'::jsonb)
        from level2
      ),
    'jobcode_level3',
      (
        select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id, 'parent_name', parent_name, 'grandparent_id', grandparent_id, 'grandparent_name', grandparent_name) order by grandparent_name, parent_name, name), '[]'::jsonb)
        from level3
      ),
    'service_items',
      (
        select coalesce(jsonb_agg(name order by name), '[]'::jsonb)
        from service_items
      )
  ) into result;

  return result;
end;
$$;

revoke all on function public.dashboard_qbtime_filter_options() from public;
revoke all on function public.dashboard_qbtime_filter_options() from anon;
grant execute on function public.dashboard_qbtime_filter_options() to authenticated;
