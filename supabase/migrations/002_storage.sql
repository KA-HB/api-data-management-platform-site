insert into storage.buckets(id, name, public)
values ('imports', 'imports', false)
on conflict (id) do nothing;

create policy "admins manage import files" on storage.objects
for all
using (bucket_id = 'imports' and public.is_admin())
with check (bucket_id = 'imports' and public.is_admin());
