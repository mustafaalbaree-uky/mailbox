-- No way existed to remove anything, so test runs sat in Ayman's view forever.
-- Both functions return the storage paths they orphaned, so the app can delete
-- the actual image files in the same step.

create or replace function public.delete_mail_item(p_item uuid)
returns text[] language plpgsql security definer set search_path = public as $$
declare
  v_paths text[];
begin
  perform public.require_role('courier');

  select coalesce(array_agg(path), '{}') into v_paths
    from public.item_photos where item_id = p_item;

  -- item_photos and item_events cascade from this.
  delete from public.mail_items where id = p_item;
  if not found then
    raise exception 'that item no longer exists';
  end if;

  return v_paths;
end;
$$;

create or replace function public.delete_watch_item(p_watch uuid)
returns text[] language plpgsql security definer set search_path = public as $$
declare
  v_path text;
begin
  if not public.is_member() then
    raise exception 'not signed in';
  end if;

  delete from public.watch_items where id = p_watch returning photo_path into v_path;
  if not found then
    raise exception 'that entry no longer exists';
  end if;

  return case when v_path is null then '{}'::text[] else array[v_path] end;
end;
$$;

grant execute on function
  public.delete_mail_item(uuid),
  public.delete_watch_item(uuid)
to authenticated;

-- The owner may now clear his own watch photos out of storage as well.
drop policy if exists mail_delete on storage.objects;

create policy mail_delete on storage.objects for delete
  using (
    bucket_id = 'mail'
    and (
      public.my_role() = 'courier'
      or (public.my_role() = 'owner' and name like 'watch/%')
    )
  );
