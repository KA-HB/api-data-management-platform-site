update public.sync_logs
set
  message = nullif(
    btrim(
      regexp_replace(
        regexp_replace(coalesce(message, ''), 'PTO:[^;]*(;\s*)?', '', 'gi'),
        '(^\s*;\s*|;\s*$)',
        '',
        'g'
      )
    ),
    ''
  ),
  stats = case
    when stats is not null and stats::text ~* 'pto' then '{}'::jsonb
    else stats
  end
where provider in ('qbtime', 'quickbooks_time')
  and (
    coalesce(message, '') ~* 'pto'
    or coalesce(stats::text, '') ~* 'pto'
  );
