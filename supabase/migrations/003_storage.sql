-- All buckets are PRIVATE. Access via signed URLs only (1hr expiry).
insert into storage.buckets (id, name, public) values
  ('avatars',         'avatars',         false),
  ('wardrobe-images', 'wardrobe-images', false),
  ('tryon-results',   'tryon-results',   false);

-- Storage RLS: users can only access their own folder (user_id prefix)
create policy "avatar upload" on storage.objects
  for insert with check (
    bucket_id = 'avatars' and
    (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatar read" on storage.objects
  for select using (
    bucket_id = 'avatars' and
    (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "wardrobe upload" on storage.objects
  for insert with check (
    bucket_id = 'wardrobe-images' and
    (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "wardrobe read" on storage.objects
  for select using (
    bucket_id = 'wardrobe-images' and
    (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "tryon upload" on storage.objects
  for insert with check (
    bucket_id = 'tryon-results' and
    (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "tryon read" on storage.objects
  for select using (
    bucket_id = 'tryon-results' and
    (storage.foldername(name))[1] = auth.uid()::text
  );
