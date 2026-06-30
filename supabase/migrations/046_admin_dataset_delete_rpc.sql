-- Delete datasets through a security-definer RPC so the browser does not have
-- to rely on cascading deletes through RLS-protected tables. QuickBooks Time
-- support/reference datasets stay internal because dashboards need them for
-- employee and job-code names, and sync will recreate them if removed.

create or replace function public.delete_dataset_admin(dataset_uuid uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_dataset public.datasets%rowtype;
  deleted_records integer := 0;
  deleted_permissions integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_admin() then
    raise exception 'Admin role required';
  end if;

  select *
  into target_dataset
  from public.datasets
  where id = dataset_uuid;

  if not found then
    raise exception 'Dataset not found';
  end if;

  if target_dataset.name = 'QuickBooks Time Timesheets' then
    raise exception 'QuickBooks Time Timesheets is the primary synced dataset and should stay available for dashboards.';
  end if;

  if target_dataset.name ilike 'QuickBooks Time %' then
    raise exception 'QuickBooks Time support datasets are managed by sync and hidden from Dataset Management because dashboards use them for names and filters.';
  end if;

  delete from public.records
  where dataset_id = dataset_uuid;
  get diagnostics deleted_records = row_count;

  delete from public.dataset_permissions
  where dataset_id = dataset_uuid;
  get diagnostics deleted_permissions = row_count;

  delete from public.datasets
  where id = dataset_uuid;

  return jsonb_build_object(
    'dataset_id', dataset_uuid,
    'dataset_name', target_dataset.name,
    'records_deleted', deleted_records,
    'permissions_deleted', deleted_permissions
  );
end;
$$;

revoke all on function public.delete_dataset_admin(uuid) from public;
revoke all on function public.delete_dataset_admin(uuid) from anon;
grant execute on function public.delete_dataset_admin(uuid) to authenticated;
notify pgrst, 'reload schema';
