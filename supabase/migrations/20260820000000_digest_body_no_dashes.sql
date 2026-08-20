-- digest_body built the notification email with an em dash in front of each
-- quoted note, reason, and response. Same text, comma instead of the dash.
-- Nothing else in the function changes: same signature, same volatility,
-- same security definer and search_path, so grants are preserved.

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
               coalesce(', "' || (detail->>'note') || '"', ''), e'\n' order by id)
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
             coalesce(', "' || (detail->>'reason') || '"', ''), e'\n' order by id) into v_list
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
             coalesce(', "' || (detail->>'note') || '"', ''), e'\n' order by id) into v_list
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
