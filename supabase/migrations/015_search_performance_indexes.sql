create index if not exists records_dataset_source_hash_idx
on public.records(dataset_id, source_hash);

create index if not exists records_created_idx
on public.records(created_at desc);

create index if not exists records_json_date_idx
on public.records((json_data->>'date'));

create index if not exists records_json_local_date_idx
on public.records((json_data->>'local_date'));

create index if not exists records_json_start_date_idx
on public.records((left(json_data->>'start', 10)));

create index if not exists records_service_item_trgm_idx
on public.records using gin (
  lower(coalesce(json_data #>> '{customfields,53105}', json_data->>'service item', json_data->>'service_item', '')) gin_trgm_ops
);

create index if not exists records_employee_fname_trgm_idx
on public.records using gin (lower(coalesce(json_data->>'fname', '')) gin_trgm_ops);

create index if not exists records_employee_lname_trgm_idx
on public.records using gin (lower(coalesce(json_data->>'lname', '')) gin_trgm_ops);

create index if not exists records_employee_first_name_trgm_idx
on public.records using gin (lower(coalesce(json_data->>'first_name', '')) gin_trgm_ops);

create index if not exists records_employee_last_name_trgm_idx
on public.records using gin (lower(coalesce(json_data->>'last_name', '')) gin_trgm_ops);

create index if not exists records_employee_display_name_trgm_idx
on public.records using gin (lower(coalesce(json_data->>'employee_name', json_data->>'display_name', '')) gin_trgm_ops);

create index if not exists records_username_trgm_idx
on public.records using gin (lower(coalesce(json_data->>'username', '')) gin_trgm_ops);

create index if not exists records_email_trgm_idx
on public.records using gin (lower(coalesce(json_data->>'email', '')) gin_trgm_ops);

create index if not exists records_jobcode_1_trgm_idx
on public.records using gin (lower(coalesce(json_data->>'jobcode_1', json_data->>'jobcode_level1', '')) gin_trgm_ops);

create index if not exists records_jobcode_2_trgm_idx
on public.records using gin (lower(coalesce(json_data->>'jobcode_2', json_data->>'jobcode_level2', '')) gin_trgm_ops);

create index if not exists records_jobcode_3_trgm_idx
on public.records using gin (lower(coalesce(json_data->>'jobcode_3', json_data->>'jobcode_level3', '')) gin_trgm_ops);

create index if not exists records_jobcode_name_trgm_idx
on public.records using gin (
  lower(coalesce(json_data->>'name', json_data->>'jobcode_name', json_data->>'short_code', '')) gin_trgm_ops
);

create index if not exists records_customer_project_trgm_idx
on public.records using gin (lower(coalesce(json_data->>'customer', json_data->>'customer_name', json_data->>'project', json_data->>'project_name', '')) gin_trgm_ops);

create index if not exists records_user_id_idx
on public.records((json_data->>'user_id'));

create index if not exists records_jobcode_id_idx
on public.records((json_data->>'jobcode_id'));
