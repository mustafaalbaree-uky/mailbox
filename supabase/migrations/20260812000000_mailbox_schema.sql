-- Mailbox schema. Paste this whole file into the Supabase SQL editor and run it.
-- Safe to re-run: everything is dropped and recreated.

-- ---------------------------------------------------------------- tables

drop table if exists public.item_events cascade;
drop table if exists public.item_photos cascade;
drop table if exists public.watch_items cascade;
drop table if exists public.visit_requests cascade;
drop table if exists public.mail_items cascade;
drop table if exists public.schedule cascade;
drop table if exists public.profiles cascade;

create table public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  role         text not null check (role in ('courier', 'owner')),
  display_name text not null,
  created_at   timestamptz not null default now()
);

create table public.mail_items (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  created_by         uuid not null references auth.users,
  label              text,
  courier_note       text,
  status             text not null default 'awaiting_decision'
                       check (status in ('awaiting_decision', 'action_needed', 'awaiting_review', 'done')),
  decision           text check (decision in ('forward', 'hold', 'discard', 'open_photo', 'open_scan')),
  decision_note      text,
  decided_at         timestamptz,
  final_disposition  text check (final_disposition in ('forwarded', 'held', 'discarded')),
  completed_at       timestamptz,
  updated_at         timestamptz not null default now()
);

create index mail_items_status_idx on public.mail_items (status, created_at desc);

create table public.item_photos (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.mail_items on delete cascade,
  path       text not null,
  kind       text not null check (kind in ('envelope', 'contents')),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users
);

create index item_photos_item_idx on public.item_photos (item_id, created_at);

create table public.item_events (
  id         bigserial primary key,
  item_id    uuid not null references public.mail_items on delete cascade,
  actor      uuid not null references auth.users,
  kind       text not null,
  detail     text,
  created_at timestamptz not null default now()
);

create index item_events_item_idx on public.item_events (item_id, created_at);

create table public.watch_items (
  id              uuid primary key default gen_random_uuid(),
  description     text not null,
  details         text,
  created_at      timestamptz not null default now(),
  created_by      uuid not null references auth.users,
  status          text not null default 'watching' check (status in ('watching', 'found', 'cancelled')),
  resolved_at     timestamptz,
  matched_item_id uuid references public.mail_items on delete set null
);

create table public.schedule (
  id               int primary key default 1 check (id = 1),
  next_visit_date  date not null,
  interval_days    int not null default 7 check (interval_days between 1 and 90),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users
);

insert into public.schedule (id, next_visit_date) values (1, current_date + 7);

create table public.visit_requests (
  id             uuid primary key default gen_random_uuid(),
  requested_date date not null,
  reason         text,
  status         text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at     timestamptz not null default now(),
  created_by     uuid not null references auth.users,
  responded_at   timestamptz,
  response_note  text
);

-- ---------------------------------------------------------------- helpers

create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid());
$$;

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select p.role from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.require_role(want text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if public.my_role() is distinct from want then
    raise exception 'this action is only available to the % account', want
      using errcode = '42501';
  end if;
end;
$$;

-- ------------------------------------------------------------------- rls
-- Both accounts read everything (it is one shared mailbox). Writes go through
-- the rpc functions below, which enforce which role may do what. The only
-- direct inserts allowed are the ones that cannot change another row's state.

alter table public.profiles       enable row level security;
alter table public.mail_items     enable row level security;
alter table public.item_photos    enable row level security;
alter table public.item_events    enable row level security;
alter table public.watch_items    enable row level security;
alter table public.schedule       enable row level security;
alter table public.visit_requests enable row level security;

create policy read_profiles       on public.profiles       for select using (public.is_member());
create policy read_mail_items     on public.mail_items     for select using (public.is_member());
create policy read_item_photos    on public.item_photos    for select using (public.is_member());
create policy read_item_events    on public.item_events    for select using (public.is_member());
create policy read_watch_items    on public.watch_items    for select using (public.is_member());
create policy read_schedule       on public.schedule       for select using (public.is_member());
create policy read_visit_requests on public.visit_requests for select using (public.is_member());

-- Only the courier files new mail and attaches photos.
create policy insert_mail_items on public.mail_items for insert
  with check (public.my_role() = 'courier' and created_by = auth.uid());

create policy insert_item_photos on public.item_photos for insert
  with check (public.my_role() = 'courier' and created_by = auth.uid());

create policy delete_item_photos on public.item_photos for delete
  using (public.my_role() = 'courier' and created_by = auth.uid());

-- Only the owner adds things to watch for; either account can insert nothing else.
create policy insert_watch_items on public.watch_items for insert
  with check (public.my_role() = 'owner' and created_by = auth.uid());

-- --------------------------------------------------------------- rpc: mail

-- The courier files one piece of mail. Photos are uploaded to storage first,
-- then their paths are passed here so the item and its photos land together.
create or replace function public.file_mail_item(
  p_label text,
  p_note text,
  p_paths text[]
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_path text;
begin
  perform public.require_role('courier');
  insert into public.mail_items (created_by, label, courier_note)
    values (auth.uid(), nullif(trim(coalesce(p_label, '')), ''), nullif(trim(coalesce(p_note, '')), ''))
    returning id into v_id;

  foreach v_path in array coalesce(p_paths, '{}') loop
    insert into public.item_photos (item_id, path, kind, created_by)
      values (v_id, v_path, 'envelope', auth.uid());
  end loop;

  insert into public.item_events (item_id, actor, kind, detail)
    values (v_id, auth.uid(), 'filed', p_label);
  return v_id;
end;
$$;

-- The owner tells the courier what to do with a piece of mail.
create or replace function public.set_decision(
  p_item uuid,
  p_decision text,
  p_note text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_status text;
begin
  perform public.require_role('owner');
  select status into v_status from public.mail_items where id = p_item;
  if v_status is null then
    raise exception 'no such mail item';
  end if;
  if v_status not in ('awaiting_decision', 'awaiting_review') then
    raise exception 'that item is not waiting on a decision right now';
  end if;
  -- Once it is open, asking for it to be opened again is meaningless, but asking
  -- for a proper scan of something we only have a phone photo of is not.
  if v_status = 'awaiting_review' and p_decision = 'open_photo' then
    raise exception 'that item has already been opened';
  end if;

  update public.mail_items set
    decision      = p_decision,
    decision_note = nullif(trim(coalesce(p_note, '')), ''),
    decided_at    = now(),
    status        = 'action_needed',
    updated_at    = now()
  where id = p_item;

  insert into public.item_events (item_id, actor, kind, detail)
    values (p_item, auth.uid(), 'decided', p_decision);
end;
$$;

-- The owner changes their mind before the courier has acted.
create or replace function public.undo_decision(p_item uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_opened boolean;
begin
  perform public.require_role('owner');
  select exists (select 1 from public.item_events e where e.item_id = p_item and e.kind = 'opened')
    into v_opened;

  update public.mail_items set
    decision      = null,
    decision_note = null,
    decided_at    = null,
    status        = case when v_opened then 'awaiting_review' else 'awaiting_decision' end,
    updated_at    = now()
  where id = p_item and status = 'action_needed';

  if not found then
    raise exception 'too late to undo, the item has already moved on';
  end if;

  insert into public.item_events (item_id, actor, kind) values (p_item, auth.uid(), 'undecided');
end;
$$;

-- The courier opened the envelope and uploaded photos of what was inside.
create or replace function public.mark_opened(p_item uuid, p_paths text[])
returns void language plpgsql security definer set search_path = public as $$
declare
  v_path text;
begin
  perform public.require_role('courier');

  foreach v_path in array coalesce(p_paths, '{}') loop
    insert into public.item_photos (item_id, path, kind, created_by)
      values (p_item, v_path, 'contents', auth.uid());
  end loop;

  update public.mail_items set
    status     = 'awaiting_review',
    decision   = null,
    updated_at = now()
  where id = p_item and status = 'action_needed'
    and decision in ('open_photo', 'open_scan');

  if not found then
    raise exception 'that item was not waiting to be opened';
  end if;

  insert into public.item_events (item_id, actor, kind) values (p_item, auth.uid(), 'opened');
end;
$$;

-- The courier finished the requested action and the item is closed out.
create or replace function public.complete_item(p_item uuid, p_disposition text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role('courier');

  update public.mail_items set
    status            = 'done',
    final_disposition = p_disposition,
    completed_at      = now(),
    updated_at        = now()
  where id = p_item and status = 'action_needed';

  if not found then
    raise exception 'that item has nothing pending on my end';
  end if;

  insert into public.item_events (item_id, actor, kind, detail)
    values (p_item, auth.uid(), 'completed', p_disposition);
end;
$$;

-- --------------------------------------------------------- rpc: watch list

create or replace function public.resolve_watch(
  p_watch uuid,
  p_status text,
  p_item uuid
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member() then
    raise exception 'not signed in';
  end if;
  if p_status not in ('found', 'cancelled', 'watching') then
    raise exception 'bad status';
  end if;

  update public.watch_items set
    status          = p_status,
    resolved_at     = case when p_status = 'watching' then null else now() end,
    matched_item_id = p_item
  where id = p_watch;
end;
$$;

-- ---------------------------------------------------------- rpc: schedule

create or replace function public.set_schedule(p_next date, p_interval int)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role('courier');
  update public.schedule set
    next_visit_date = coalesce(p_next, next_visit_date),
    interval_days   = coalesce(p_interval, interval_days),
    updated_at      = now(),
    updated_by      = auth.uid()
  where id = 1;
end;
$$;

-- The courier went on the run; roll the date forward by one interval.
create or replace function public.log_visit()
returns date language plpgsql security definer set search_path = public as $$
declare
  v_next date;
begin
  perform public.require_role('courier');
  update public.schedule set
    next_visit_date = greatest(current_date, next_visit_date) + interval_days,
    updated_at      = now(),
    updated_by      = auth.uid()
  where id = 1
  returning next_visit_date into v_next;
  return v_next;
end;
$$;

create or replace function public.request_visit(p_date date, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform public.require_role('owner');
  update public.visit_requests set status = 'declined', responded_at = now(),
    response_note = 'replaced by a newer request'
    where status = 'pending';
  insert into public.visit_requests (requested_date, reason, created_by)
    values (p_date, nullif(trim(coalesce(p_reason, '')), ''), auth.uid())
    returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.respond_visit_request(
  p_request uuid,
  p_accept boolean,
  p_date date,
  p_note text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_date date;
begin
  perform public.require_role('courier');
  select requested_date into v_date from public.visit_requests where id = p_request;
  if v_date is null then
    raise exception 'no such request';
  end if;

  update public.visit_requests set
    status        = case when p_accept then 'accepted' else 'declined' end,
    responded_at  = now(),
    response_note = nullif(trim(coalesce(p_note, '')), '')
  where id = p_request and status = 'pending';

  if p_accept then
    update public.schedule set
      next_visit_date = coalesce(p_date, v_date),
      updated_at      = now(),
      updated_by      = auth.uid()
    where id = 1;
  end if;
end;
$$;

-- ------------------------------------------------------------------ grants

revoke all on function public.require_role(text) from anon, authenticated;

grant execute on function
  public.file_mail_item(text, text, text[]),
  public.set_decision(uuid, text, text),
  public.undo_decision(uuid),
  public.mark_opened(uuid, text[]),
  public.complete_item(uuid, text),
  public.resolve_watch(uuid, text, uuid),
  public.set_schedule(date, int),
  public.log_visit(),
  public.request_visit(date, text),
  public.respond_visit_request(uuid, boolean, date, text),
  public.is_member(),
  public.my_role()
to authenticated;

-- ----------------------------------------------------------------- storage
-- Private bucket. Photos are only ever reached through short lived signed urls
-- created for a signed in member.

insert into storage.buckets (id, name, public)
  values ('mail', 'mail', false)
  on conflict (id) do update set public = false;

drop policy if exists mail_read   on storage.objects;
drop policy if exists mail_write  on storage.objects;
drop policy if exists mail_delete on storage.objects;

create policy mail_read on storage.objects for select
  using (bucket_id = 'mail' and public.is_member());

create policy mail_write on storage.objects for insert
  with check (bucket_id = 'mail' and public.my_role() = 'courier');

create policy mail_delete on storage.objects for delete
  using (bucket_id = 'mail' and public.my_role() = 'courier');
