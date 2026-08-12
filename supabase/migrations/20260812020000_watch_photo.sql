-- Ayman often has a picture of the thing he is expecting before it shows up, so
-- a watch entry can carry one photo.
alter table public.watch_items add column if not exists photo_path text;

-- Uploading was courier only. The owner now needs to write too, but only under
-- the watch/ prefix, so his account still cannot touch mail photos.
drop policy if exists mail_write on storage.objects;

create policy mail_write on storage.objects for insert
  with check (
    bucket_id = 'mail'
    and (
      public.my_role() = 'courier'
      or (public.my_role() = 'owner' and name like 'watch/%')
    )
  );
