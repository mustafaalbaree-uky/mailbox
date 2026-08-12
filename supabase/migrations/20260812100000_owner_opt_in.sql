-- Two switches, both of which must be on for the owner to get email.
--
--   owner_enabled  the courier's master switch, off until Ayman says he wants
--                  notifications at all
--   owner_opt_in   Ayman's own choice, which he controls from his side
--
-- The opt in defaults to on, so once the master switch is flipped it simply
-- works, and his toggle exists to turn himself back off rather than to make him
-- perform a second setup step.
alter table public.notify_config
  add column if not exists owner_opt_in boolean not null default true;

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
    v_enabled := case
                   when aud = 'courier' then cfg.courier_enabled
                   else cfg.owner_enabled and cfg.owner_opt_in
                 end;
    v_to      := case when aud = 'courier' then cfg.courier_email else cfg.owner_email end;
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

-- The owner's own controls. He can turn himself off and correct his address,
-- and nothing else. The master switch stays with the courier.
create or replace function public.set_owner_notify(p_on boolean, p_email text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role('owner');
  update public.notify_config set
    owner_opt_in = coalesce(p_on, owner_opt_in),
    owner_email  = coalesce(nullif(trim(coalesce(p_email, '')), ''), owner_email),
    updated_at   = now()
  where id = 1;
end;
$$;

grant execute on function public.set_owner_notify(boolean, text) to authenticated;
