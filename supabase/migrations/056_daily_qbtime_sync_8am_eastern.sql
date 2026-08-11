-- Run the shared QuickBooks Time sync at 8:00 AM America/New_York every day.
-- The hourly UTC trigger plus local-time guard keeps the time stable across DST.
-- Production must provide the same random value in Edge Function SCHEDULE_SECRET
-- and Vault secret qbtime_schedule_secret.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid from cron.job where jobname = 'qbtime-daily-8am-eastern'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'qbtime-daily-8am-eastern',
  '0 * * * *',
  $job$
    select net.http_post(
      url := 'https://wtygvjmlhquzpunewpqb.supabase.co/functions/v1/scheduled-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-schedule-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'qbtime_schedule_secret'
          limit 1
        )
      ),
      body := jsonb_build_object('scheduled_at', now()),
      timeout_milliseconds := 10000
    )
    where extract(hour from timezone('America/New_York', now())) = 8;
  $job$
);
