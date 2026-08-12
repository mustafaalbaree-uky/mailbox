-- Links the two logins to their roles. Fails loudly rather than silently doing
-- nothing if an account is missing or its email does not match what the app
-- builds from the username.
do $$
declare
  v_courier uuid;
  v_owner   uuid;
begin
  select id into v_courier from auth.users where email = 'mustafa@mailbox.local';
  select id into v_owner   from auth.users where email = 'ayman@mailbox.local';

  if v_courier is null then
    raise exception 'no account found for username "mustafa" (mustafa@mailbox.local)';
  end if;
  if v_owner is null then
    raise exception 'no account found for username "ayman" (ayman@mailbox.local)';
  end if;

  insert into public.profiles (id, role, display_name)
    values (v_courier, 'courier', 'Mustafa')
    on conflict (id) do update set role = excluded.role, display_name = excluded.display_name;

  insert into public.profiles (id, role, display_name)
    values (v_owner, 'owner', 'Ayman')
    on conflict (id) do update set role = excluded.role, display_name = excluded.display_name;
end $$;
