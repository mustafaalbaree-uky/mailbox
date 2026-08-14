-- Sending the contents over was a one way door: the moment mark_opened ran, the
-- item sat with the owner and the courier had no way to take back a blurry page
-- or a photo of the wrong letter. This adds the way back.

create or replace function public.undo_opened(p_item uuid)
returns text[] language plpgsql security definer set search_path = public as $$
declare
  v_decision text;
  v_paths    text[];
begin
  perform public.require_role('courier');

  -- mark_opened clears the decision, so what he was asked to do has to come
  -- back out of the log. The item can only be in this state because of an
  -- open_photo or open_scan, so that is what the latest decision is.
  select e.detail into v_decision
    from public.item_events e
   where e.item_id = p_item and e.kind = 'decided'
   order by e.id desc
   limit 1;

  select coalesce(array_agg(path), '{}') into v_paths
    from public.item_photos
   where item_id = p_item and kind = 'contents';

  update public.mail_items set
    status     = 'action_needed',
    decision   = coalesce(v_decision, 'open_photo'),
    updated_at = now()
  where id = p_item and status = 'awaiting_review';

  if not found then
    raise exception 'that one is not sitting with him for a look right now';
  end if;

  delete from public.item_photos where item_id = p_item and kind = 'contents';

  insert into public.item_events (item_id, actor, kind)
    values (p_item, auth.uid(), 'unopened');

  -- The caller takes these out of the bucket rather than orphaning the files.
  return v_paths;
end;
$$;

grant execute on function public.undo_opened(uuid) to authenticated;

-- Undoing a send puts the item back on action_needed, which the notify trigger
-- read as "the owner has decided something" and emailed the courier his own
-- instruction back. A real decision moves decided_at; taking a send back does
-- not, so that is what separates them.
create or replace function public.tg_mail_items_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v jsonb := jsonb_build_object('seq', new.seq, 'label', new.label);
begin
  if tg_op = 'INSERT' then
    perform public.log_event('owner', 'filed', v);
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'action_needed' and new.decided_at is distinct from old.decided_at then
      perform public.log_event('courier', 'decision',
        v || jsonb_build_object('decision', new.decision, 'note', new.decision_note));
    elsif new.status = 'awaiting_review' and old.status = 'action_needed' then
      perform public.log_event('owner', 'opened', v);
    elsif new.status = 'done' then
      perform public.log_event('owner', 'completed',
        v || jsonb_build_object('disposition', new.final_disposition));
    elsif new.status = 'awaiting_decision' and old.status = 'action_needed' then
      perform public.log_event('courier', 'undecided', v);
    end if;
  end if;
  return new;
end;
$$;
