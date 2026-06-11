update public.activity_logs
set details = '{}'::jsonb
where action like 'qbtime.%'
  and coalesce(details::text, '') ~* 'pto|time_off';
