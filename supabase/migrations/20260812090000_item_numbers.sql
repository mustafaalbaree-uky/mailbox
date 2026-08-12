-- A digest that says "an unlabeled piece" sixteen times tells the courier how
-- much work he has but not which envelope is which. Labelling all of them by
-- hand at upload time is exactly the busywork this app exists to avoid, so each
-- piece gets a short number instead, shown on its card and used in the email.

create sequence if not exists public.mail_item_seq;

alter table public.mail_items add column if not exists seq bigint;

-- Existing mail keeps the order it was photographed in.
with ordered as (
  select id, row_number() over (order by created_at, id) as rn
  from public.mail_items
)
update public.mail_items m
   set seq = o.rn
  from ordered o
 where m.id = o.id and m.seq is null;

select setval('public.mail_item_seq', coalesce((select max(seq) from public.mail_items), 0), true);

alter table public.mail_items alter column seq set default nextval('public.mail_item_seq');
alter table public.mail_items alter column seq set not null;

-- One place that decides how a piece of mail is named in an email.
create or replace function public.event_label(p_detail jsonb)
returns text language sql immutable set search_path = public as $$
  select case
    when p_detail ? 'seq' then '#' || (p_detail->>'seq') ||
      coalesce(' ' || nullif(p_detail->>'label', ''), '')
    else coalesce(nullif(p_detail->>'label', ''), 'an unlabeled piece')
  end;
$$;

-- Carry the number into every event the triggers write.
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
    if new.status = 'action_needed' then
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

create or replace function public.tg_item_notes_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_from text := public.role_of(new.author);
  v jsonb;
begin
  select jsonb_build_object('seq', seq, 'label', label) into v
    from public.mail_items where id = new.item_id;
  perform public.log_event(
    case when v_from = 'courier' then 'owner' else 'courier' end,
    'note',
    v || jsonb_build_object('body', new.body));
  return new;
end;
$$;

-- Rebuilt to name each piece through event_label.
create or replace function public.digest_body(p_audience text, p_ids bigint[])
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_out   text := '';
  v_list  text;
  v_count int;
  v_decisions text[] := array['forward', 'open_scan', 'open_photo', 'hold', 'discard'];
  v_heads     text[] := array['To mail out', 'To open and scan', 'To open and photograph', 'To hold on to', 'To throw away'];
  i int;
begin
  if p_audience = 'courier' then
    for i in 1 .. array_length(v_decisions, 1) loop
      select count(*), string_agg('  - ' || public.event_label(detail) ||
               coalesce(' — "' || (detail->>'note') || '"', ''), e'\n' order by id)
        into v_count, v_list
        from public.notify_events
        where id = any(p_ids) and kind = 'decision' and detail->>'decision' = v_decisions[i];
      if v_count > 0 then
        v_out := v_out || v_heads[i] || ' (' || v_count || ')' || e'\n' || v_list || e'\n\n';
      end if;
    end loop;

    select string_agg('  - ' || public.event_label(detail), e'\n' order by id) into v_list
      from public.notify_events where id = any(p_ids) and kind = 'undecided';
    if v_list is not null then
      v_out := v_out || 'Changed his mind, back to him' || e'\n' || v_list || e'\n\n';
    end if;

    select string_agg('  - wants the run moved to ' || to_char((detail->>'date')::date, 'FMDay, FMMonth FMDD') ||
             coalesce(' — "' || (detail->>'reason') || '"', ''), e'\n' order by id) into v_list
      from public.notify_events where id = any(p_ids) and kind = 'visit_request';
    if v_list is not null then
      v_out := v_out || 'Asked for an earlier run' || e'\n' || v_list || e'\n\n';
    end if;

    select string_agg('  - ' || (detail->>'description') ||
             coalesce(' (' || (detail->>'details') || ')', ''), e'\n' order by id) into v_list
      from public.notify_events where id = any(p_ids) and kind = 'watch';
    if v_list is not null then
      v_out := v_out || 'Now watching for' || e'\n' || v_list || e'\n\n';
    end if;
  else
    select count(*), string_agg('  - ' || public.event_label(detail), e'\n' order by id)
      into v_count, v_list
      from public.notify_events where id = any(p_ids) and kind = 'filed';
    if v_count > 0 then
      v_out := v_out || 'New in your mailbox (' || v_count || ')' || e'\n' || v_list || e'\n\n';
    end if;

    select string_agg('  - ' || public.event_label(detail), e'\n' order by id) into v_list
      from public.notify_events where id = any(p_ids) and kind = 'opened';
    if v_list is not null then
      v_out := v_out || 'Opened for you, waiting on your call' || e'\n' || v_list || e'\n\n';
    end if;

    select string_agg('  - ' || public.event_label(detail) || ': ' ||
             case detail->>'disposition'
               when 'forwarded' then 'mailed to you'
               when 'held' then 'held for you'
               when 'discarded' then 'thrown away'
               else coalesce(detail->>'disposition', 'done') end, e'\n' order by id) into v_list
      from public.notify_events where id = any(p_ids) and kind = 'completed';
    if v_list is not null then
      v_out := v_out || 'Finished' || e'\n' || v_list || e'\n\n';
    end if;

    select string_agg('  - the run is ' || (detail->>'status') || ' for ' ||
             to_char((detail->>'date')::date, 'FMDay, FMMonth FMDD') ||
             coalesce(' — "' || (detail->>'note') || '"', ''), e'\n' order by id) into v_list
      from public.notify_events where id = any(p_ids) and kind = 'visit_response';
    if v_list is not null then
      v_out := v_out || 'About your request' || e'\n' || v_list || e'\n\n';
    end if;
  end if;

  select string_agg('  - on ' || public.event_label(detail) || ': "' || (detail->>'body') || '"', e'\n' order by id)
    into v_list from public.notify_events where id = any(p_ids) and kind = 'note';
  if v_list is not null then
    v_out := v_out || 'Notes' || e'\n' || v_list || e'\n\n';
  end if;

  v_out := v_out || 'Open the app to see the photos.' || e'\n';
  return v_out;
end;
$$;
