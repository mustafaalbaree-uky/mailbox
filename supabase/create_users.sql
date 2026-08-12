-- Links each login to a role. Run this AFTER creating the two users under
-- Authentication > Users in the Supabase dashboard.
--
-- The app takes a plain username and adds "@mailbox.local" behind the scenes,
-- so a user created with the email mustafa@mailbox.local signs in by typing
-- just "mustafa". Change the two usernames below if you picked different ones.

insert into public.profiles (id, role, display_name)
select u.id, 'courier', 'Mustafa'
from auth.users u
where u.email = 'mustafa@mailbox.local'
on conflict (id) do update set role = excluded.role, display_name = excluded.display_name;

insert into public.profiles (id, role, display_name)
select u.id, 'owner', 'Ayman'
from auth.users u
where u.email = 'ayman@mailbox.local'
on conflict (id) do update set role = excluded.role, display_name = excluded.display_name;

-- Check: this should print exactly two rows, one courier and one owner. If a
-- row is missing, the email in the dashboard does not match the one above.
select p.display_name, p.role, u.email
from public.profiles p join auth.users u on u.id = p.id
order by p.role;
