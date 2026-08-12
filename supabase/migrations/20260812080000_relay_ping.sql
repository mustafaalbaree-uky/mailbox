-- A plain GET against the saved webhook, so a wrong or dead url can be told
-- apart from a wrong secret without reading the database by hand.
create or replace function public.ping_relay()
returns boolean language plpgsql security definer set search_path = public, net, extensions as $$
declare
  v_url text;
begin
  perform public.require_role('courier');
  select webhook_url into v_url from public.notify_channel where id = 1;
  if v_url is null then
    return false;
  end if;

  perform net.http_get(url := v_url, timeout_milliseconds := 30000);
  return true;
end;
$$;

grant execute on function public.ping_relay() to authenticated;

-- Report the relay's version when it gives one, so a stale deployment is
-- obvious rather than inferred.
create or replace function public.last_email_result(p_after bigint default 0)
returns jsonb language plpgsql stable security definer set search_path = public, net, extensions as $$
declare
  r record;
  v_text text;
  v_ver text;
begin
  perform public.require_role('courier');

  select id, status_code, error_msg, content into r
    from net._http_response
    where id > p_after
    order by id desc limit 1;

  if r.id is null then
    return jsonb_build_object(
      'id', coalesce((select max(id) from net._http_response), 0),
      'result', 'pending');
  end if;

  v_ver := substring(coalesce(r.content, '') from '"v":\s*(\d+)');

  if r.error_msg is not null then
    v_text := 'failed: ' || r.error_msg;
  elsif r.status_code = 404 then
    v_text := 'That URL is dead (404). Copy the current one from Deploy > Manage deployments.';
  elsif r.status_code = 200 and coalesce(r.content, '') like '%"message":"sent"%' then
    v_text := 'sent';
  elsif r.status_code = 200 and coalesce(r.content, '') like '%Mailbox relay is running%' then
    v_text := 'Relay reachable, running version ' || coalesce(v_ver, 'unknown');
  elsif v_ver is not null then
    v_text := 'Relay v' || v_ver || ' said: ' ||
              coalesce(substring(r.content from '"message":"([^"]*)"'), left(r.content, 160));
  else
    v_text := 'Replied ' || coalesce(r.status_code::text, '?') || ': ' || left(coalesce(r.content, ''), 160);
  end if;

  return jsonb_build_object('id', r.id, 'result', v_text);
end;
$$;

grant execute on function public.last_email_result(bigint) to authenticated;
