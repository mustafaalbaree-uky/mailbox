-- ============================================================ free form notes
-- A running note thread on each piece of mail, either direction. This is how
-- "email me that scan please" gets said against the specific envelope it is
-- about, instead of over text message with no context.

create table if not exists public.item_notes (
  id         bigserial primary key,
  item_id    uuid not null references public.mail_items on delete cascade,
  author     uuid not null references auth.users,
  body       text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists item_notes_item_idx on public.item_notes (item_id, created_at);

alter table public.item_notes enable row level security;

create policy read_item_notes on public.item_notes for select using (public.is_member());

create policy insert_item_notes on public.item_notes for insert
  with check (public.is_member() and author = auth.uid());

create policy delete_item_notes on public.item_notes for delete
  using (author = auth.uid());

-- ====================================================== notification plumbing

-- Who gets what. The courier owns these settings from the app.
create table if not exists public.notify_config (
  id              int primary key default 1 check (id = 1),
  courier_email   text,
  owner_email     text,
  courier_enabled boolean not null default true,
  owner_enabled   boolean not null default false,
  digest_minutes  int not null default 60 check (digest_minutes between 5 and 1440),
  run_reminder    boolean not null default true,
  updated_at      timestamptz not null default now()
);

insert into public.notify_config (id) values (1) on conflict (id) do nothing;

-- The webhook url and shared secret live apart from the settings, with no
-- select policy at all, so a signed in browser can never read them back. Only
-- the digest function, which runs as the definer, ever looks at this table.
create table if not exists public.notify_channel (
  id          int primary key default 1 check (id = 1),
  webhook_url text,
  secret      text,
  updated_at  timestamptz not null default now()
);

insert into public.notify_channel (id) values (1) on conflict (id) do nothing;

-- Append only log of things worth telling someone about. Rows are written by
-- triggers, so nothing can happen in the app without landing here.
create table if not exists public.notify_events (
  id         bigserial primary key,
  audience   text not null check (audience in ('courier', 'owner')),
  kind       text not null,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);

create index if not exists notify_events_pending_idx
  on public.notify_events (audience, created_at) where sent_at is null;

alter table public.notify_config  enable row level security;
alter table public.notify_channel enable row level security;
alter table public.notify_events  enable row level security;

create policy read_notify_config on public.notify_config for select using (public.is_member());
-- notify_channel deliberately has no policy: unreachable from the app.
create policy read_notify_events on public.notify_events for select using (public.my_role() = 'courier');

-- ------------------------------------------------------------------ triggers

create or replace function public.role_of(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = p_user;
$$;

create or replace function public.log_event(p_audience text, p_kind text, p_detail jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.notify_events (audience, kind, detail) values (p_audience, p_kind, coalesce(p_detail, '{}'::jsonb));
$$;

create or replace function public.tg_mail_items_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_label text := coalesce(new.label, 'an unlabeled piece');
begin
  if tg_op = 'INSERT' then
    perform public.log_event('owner', 'filed', jsonb_build_object('label', v_label));
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'action_needed' then
      perform public.log_event('courier', 'decision', jsonb_build_object(
        'label', v_label, 'decision', new.decision, 'note', new.decision_note));
    elsif new.status = 'awaiting_review' and old.status = 'action_needed' then
      perform public.log_event('owner', 'opened', jsonb_build_object('label', v_label));
    elsif new.status = 'done' then
      perform public.log_event('owner', 'completed', jsonb_build_object(
        'label', v_label, 'disposition', new.final_disposition));
    elsif new.status = 'awaiting_decision' and old.status = 'action_needed' then
      perform public.log_event('courier', 'undecided', jsonb_build_object('label', v_label));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists mail_items_notify on public.mail_items;
create trigger mail_items_notify
  after insert or update on public.mail_items
  for each row execute function public.tg_mail_items_notify();

create or replace function public.tg_visit_requests_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_event('courier', 'visit_request', jsonb_build_object(
      'date', new.requested_date, 'reason', new.reason));
  elsif new.status is distinct from old.status and new.status <> 'pending' then
    perform public.log_event('owner', 'visit_response', jsonb_build_object(
      'status', new.status, 'date', new.requested_date, 'note', new.response_note));
  end if;
  return new;
end;
$$;

drop trigger if exists visit_requests_notify on public.visit_requests;
create trigger visit_requests_notify
  after insert or update on public.visit_requests
  for each row execute function public.tg_visit_requests_notify();

create or replace function public.tg_watch_items_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.log_event('courier', 'watch', jsonb_build_object(
    'description', new.description, 'details', new.details));
  return new;
end;
$$;

drop trigger if exists watch_items_notify on public.watch_items;
create trigger watch_items_notify
  after insert on public.watch_items
  for each row execute function public.tg_watch_items_notify();

create or replace function public.tg_item_notes_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_from  text := public.role_of(new.author);
  v_label text;
begin
  select coalesce(label, 'an unlabeled piece') into v_label from public.mail_items where id = new.item_id;
  perform public.log_event(
    case when v_from = 'courier' then 'owner' else 'courier' end,
    'note',
    jsonb_build_object('label', v_label, 'body', new.body));
  return new;
end;
$$;

drop trigger if exists item_notes_notify on public.item_notes;
create trigger item_notes_notify
  after insert on public.item_notes
  for each row execute function public.tg_item_notes_notify();

-- --------------------------------------------------------------- the digest

-- Ordered by how much work each one costs the courier, hardest first, because
-- that is the order the decisions need to be planned around.
create or replace function public.digest_body(p_audience text, p_ids bigint[])
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_out   text := '';
  v_kind  text;
  v_head  text;
  v_list  text;
  v_count int;
  v_decisions text[] := array['forward', 'open_scan', 'open_photo', 'hold', 'discard'];
  v_heads     text[] := array['To mail out', 'To open and scan', 'To open and photograph', 'To hold on to', 'To throw away'];
  i int;
begin
  if p_audience = 'courier' then
    for i in 1 .. array_length(v_decisions, 1) loop
      select count(*), string_agg('  - ' || (detail->>'label') ||
               coalesce(' — "' || (detail->>'note') || '"', ''), e'\n' order by id)
        into v_count, v_list
        from public.notify_events
        where id = any(p_ids) and kind = 'decision' and detail->>'decision' = v_decisions[i];
      if v_count > 0 then
        v_out := v_out || v_heads[i] || ' (' || v_count || ')' || e'\n' || v_list || e'\n\n';
      end if;
    end loop;

    select string_agg('  - ' || (detail->>'label'), e'\n' order by id) into v_list
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
    select count(*) into v_count from public.notify_events where id = any(p_ids) and kind = 'filed';
    if v_count > 0 then
      v_out := v_out || 'New in your mailbox (' || v_count || ')' || e'\n\n';
    end if;

    select string_agg('  - ' || (detail->>'label'), e'\n' order by id) into v_list
      from public.notify_events where id = any(p_ids) and kind = 'opened';
    if v_list is not null then
      v_out := v_out || 'Opened for you, waiting on your call' || e'\n' || v_list || e'\n\n';
    end if;

    select string_agg('  - ' || (detail->>'label') || ': ' ||
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

  select string_agg('  - on ' || (detail->>'label') || ': "' || (detail->>'body') || '"', e'\n' order by id)
    into v_list from public.notify_events where id = any(p_ids) and kind = 'note';
  if v_list is not null then
    v_out := v_out || 'Notes' || e'\n' || v_list || e'\n\n';
  end if;

  return v_out;
end;
$$;

create or replace function public.digest_subject(p_audience text, p_ids bigint[])
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_n int;
  v_extra int;
begin
  if p_audience = 'courier' then
    select count(*) into v_n from public.notify_events where id = any(p_ids) and kind = 'decision';
    select count(*) into v_extra from public.notify_events where id = any(p_ids) and kind = 'visit_request';
    if v_extra > 0 then
      return 'Mailbox: Ayman wants an earlier run' || case when v_n > 0 then ' (and ' || v_n || ' decisions)' else '' end;
    end if;
    if v_n > 0 then
      return 'Mailbox: Ayman made ' || v_n || ' decision' || case when v_n = 1 then '' else 's' end;
    end if;
    return 'Mailbox: an update from Ayman';
  end if;

  select count(*) into v_n from public.notify_events where id = any(p_ids) and kind = 'filed';
  if v_n > 0 then
    return 'Mailbox: ' || v_n || ' new piece' || case when v_n = 1 then '' else 's' end || ' of mail';
  end if;
  return 'Mailbox: an update from Mustafa';
end;
$$;

-- Hands one email to the webhook. Returns false when the channel is not set up
-- yet, so the caller can stay quiet rather than error.
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
                 'body',    p_body)
  );
  return true;
end;
$$;

-- Runs on a schedule. For each side, if there are unsent events and the oldest
-- one is older than the quiet window, everything since then goes out as one
-- email. That is what stops sixteen decisions becoming sixteen emails.
create or replace function public.send_due_digests()
returns int language plpgsql security definer set search_path = public as $$
declare
  cfg record;
  aud text;
  v_ids bigint[];
  v_oldest timestamptz;
  v_enabled boolean;
  v_to text;
  v_sent int := 0;
begin
  select * into cfg from public.notify_config where id = 1;

  foreach aud in array array['courier', 'owner'] loop
    v_enabled := case when aud = 'courier' then cfg.courier_enabled else cfg.owner_enabled end;
    v_to      := case when aud = 'courier' then cfg.courier_email   else cfg.owner_email end;
    continue when not v_enabled or v_to is null or trim(v_to) = '';

    select array_agg(id), min(created_at) into v_ids, v_oldest
      from public.notify_events where audience = aud and sent_at is null;

    continue when v_ids is null;
    continue when v_oldest > now() - make_interval(mins => cfg.digest_minutes);

    if public.send_email(v_to, public.digest_subject(aud, v_ids), public.digest_body(aud, v_ids)) then
      update public.notify_events set sent_at = now() where id = any(v_ids);
      v_sent := v_sent + 1;
    end if;
  end loop;

  return v_sent;
end;
$$;

-- "It is mail day." Sent the morning of, and only once, because the events row
-- it writes is what the uniqueness check looks at.
create or replace function public.send_run_reminder()
returns boolean language plpgsql security definer set search_path = public as $$
declare
  cfg record;
  v_date date;
  v_waiting int;
begin
  select * into cfg from public.notify_config where id = 1;
  if not cfg.run_reminder or not cfg.courier_enabled then return false; end if;

  select next_visit_date into v_date from public.schedule where id = 1;
  if v_date is distinct from current_date then return false; end if;

  if exists (
    select 1 from public.notify_events
    where kind = 'run_reminder' and (detail->>'date')::date = v_date
  ) then
    return false;
  end if;

  select count(*) into v_waiting from public.mail_items where status = 'action_needed';

  insert into public.notify_events (audience, kind, detail, sent_at)
    values ('courier', 'run_reminder', jsonb_build_object('date', v_date), now());

  return public.send_email(
    cfg.courier_email,
    'Mailbox: mail run today',
    'Today is the day you check the mail.' || e'\n\n' ||
    case when v_waiting > 0
      then v_waiting || ' piece' || case when v_waiting = 1 then '' else 's' end ||
           ' already have something waiting on you.' || e'\n\n'
      else '' end ||
    'https://mustafaalbaree-uky.github.io/mailbox/' || e'\n');
end;
$$;

-- ------------------------------------------------------------- app settings

create or replace function public.set_notify_config(
  p_courier_email text,
  p_owner_email text,
  p_courier_enabled boolean,
  p_owner_enabled boolean,
  p_digest_minutes int,
  p_run_reminder boolean
) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role('courier');
  update public.notify_config set
    courier_email   = nullif(trim(coalesce(p_courier_email, '')), ''),
    owner_email     = nullif(trim(coalesce(p_owner_email, '')), ''),
    courier_enabled = coalesce(p_courier_enabled, courier_enabled),
    owner_enabled   = coalesce(p_owner_enabled, owner_enabled),
    digest_minutes  = coalesce(p_digest_minutes, digest_minutes),
    run_reminder    = coalesce(p_run_reminder, run_reminder),
    updated_at      = now()
  where id = 1;
end;
$$;

-- Write only: the app can set the webhook but can never read it back.
create or replace function public.set_notify_channel(p_url text, p_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role('courier');
  update public.notify_channel set
    webhook_url = nullif(trim(coalesce(p_url, '')), ''),
    secret      = coalesce(nullif(trim(coalesce(p_secret, '')), ''), secret),
    updated_at  = now()
  where id = 1;
end;
$$;

create or replace function public.notify_channel_ready()
returns boolean language sql stable security definer set search_path = public as $$
  select webhook_url is not null from public.notify_channel where id = 1;
$$;

-- Lets the courier prove the whole path works without waiting on the window.
create or replace function public.send_test_email(p_to text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role('courier');
  return public.send_email(
    p_to,
    'Mailbox: test email',
    'If you are reading this, notifications are wired up correctly.' || e'\n');
end;
$$;

grant execute on function
  public.set_notify_config(text, text, boolean, boolean, int, boolean),
  public.set_notify_channel(text, text),
  public.notify_channel_ready(),
  public.send_test_email(text)
to authenticated;

revoke all on function
  public.send_email(text, text, text),
  public.send_due_digests(),
  public.send_run_reminder(),
  public.log_event(text, text, jsonb)
from anon, authenticated;

-- ------------------------------------------------------------------- schedule

select cron.unschedule('mailbox-digest')     where exists (select 1 from cron.job where jobname = 'mailbox-digest');
select cron.unschedule('mailbox-run-remind') where exists (select 1 from cron.job where jobname = 'mailbox-run-remind');

-- Every ten minutes is fine: the quiet window, not the tick rate, decides when
-- an email actually goes out.
select cron.schedule('mailbox-digest', '*/10 * * * *', $$select public.send_due_digests()$$);

-- 12:00 UTC is early morning in Kentucky.
select cron.schedule('mailbox-run-remind', '0 12 * * *', $$select public.send_run_reminder()$$);
