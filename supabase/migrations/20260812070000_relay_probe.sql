-- Reporting "the newest response" was wrong: the newest one is usually left over
-- from a previous attempt, so a fresh send would instantly report the old
-- failure. The caller now passes the id it saw before sending, and only a
-- response newer than that counts as an answer to this send.
drop function if exists public.last_email_result();

create or replace function public.last_email_result(p_after bigint default 0)
returns jsonb language plpgsql stable security definer set search_path = public, net, extensions as $$
declare
  r record;
  v_text text;
begin
  perform public.require_role('courier');

  select id, status_code, error_msg, content into r
    from net._http_response
    where id > p_after
    order by id desc limit 1;

  if r.id is null then
    -- No newer response yet. Hand back the highest id we know about so the
    -- caller can use it as a baseline.
    return jsonb_build_object(
      'id', coalesce((select max(id) from net._http_response), 0),
      'result', 'pending');
  end if;

  if r.error_msg is not null then
    v_text := 'failed: ' || r.error_msg;
  elsif r.status_code = 200 and coalesce(r.content, '') like '%"message":"sent"%' then
    v_text := 'sent';
  else
    v_text := 'relay replied ' || coalesce(r.status_code::text, '?') || ': ' ||
              left(coalesce(r.content, ''), 200);
  end if;

  return jsonb_build_object('id', r.id, 'result', v_text);
end;
$$;

grant execute on function public.last_email_result(bigint) to authenticated;
