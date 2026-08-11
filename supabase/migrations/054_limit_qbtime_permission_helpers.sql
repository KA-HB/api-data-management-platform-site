-- Keep administrative provisioning helpers private while allowing users to
-- repair only their own profile through ensure_current_profile().

revoke execute on function public.auth_user_login_email(uuid) from authenticated;
revoke execute on function public.is_allowed_login_email(text) from authenticated;
revoke execute on function public.grant_shared_qbtime_dataset_permissions(uuid) from authenticated;
revoke execute on function public.grant_qbtime_permissions_for_dataset() from authenticated;

grant execute on function public.auth_user_login_email(uuid) to service_role;
grant execute on function public.is_allowed_login_email(text) to service_role;
grant execute on function public.grant_shared_qbtime_dataset_permissions(uuid) to service_role;
grant execute on function public.ensure_current_profile() to authenticated;

notify pgrst, 'reload schema';
