-- pg_net defaults to a 5 second timeout. An Apps Script web app has to wake up,
-- follow a redirect, and hand the message to Gmail, which regularly takes longer
-- than that, so every send was being abandoned just before it succeeded.
create or replace function public.send_email(p_to text, p_subject text, p_body text)
returns boolean language plpgsql security definer set search_path = public, net, extensions as $$
declare
  ch record;
begin
  select * into ch from public.notify_channel where id = 1;
  if ch.webhook_url is null or p_to is null or trim(p_to) = '' then
    return false;
  end if;

  perform net.http_post(
    url     := ch.webhook_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object(
                 'secret',  ch.secret,
                 'to',      p_to,
                 'subject', p_subject,
                 'body',    p_body),
    timeout_milliseconds := 30000
  );
  return true;
end;
$$;

-- Sending is asynchronous, so "sent" from the app only ever meant "queued".
-- This reports what the relay actually said, so a test proves something.
create or replace function public.last_email_result()
returns text language plpgsql stable security definer set search_path = public, net, extensions as $$
declare
  r record;
begin
  perform public.require_role('courier');

  select status_code, error_msg, content into r
    from net._http_response order by id desc limit 1;

  if r is null then
    return 'nothing sent yet';
  end if;
  if r.error_msg is not null then
    return 'failed: ' || r.error_msg;
  end if;
  if r.status_code = 200 and coalesce(r.content, '') like '%"message":"sent"%' then
    return 'sent';
  end if;
  return 'relay replied ' || coalesce(r.status_code::text, '?') || ': ' || left(coalesce(r.content, ''), 200);
end;
$$;

grant execute on function public.last_email_result() to authenticated;
