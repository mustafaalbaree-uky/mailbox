-- Run this AFTER schema.sql, and after you have created the two accounts under
-- Authentication > Users in the Supabase dashboard.
--
-- Replace the two email addresses below with the ones you actually used, then
-- run the whole file. It links each login to a role. The role is what decides
-- which of the two interfaces the app shows and what the database will let that
-- account do.

insert into public.profiles (id, role, display_name)
select u.id, 'courier', 'Mustafa'
from auth.users u
where u.email = 'REPLACE_ME_courier@example.com'
on conflict (id) do update set role = excluded.role, display_name = excluded.display_name;

insert into public.profiles (id, role, display_name)
select u.id, 'owner', 'Uncle'
from auth.users u
where u.email = 'REPLACE_ME_owner@example.com'
on conflict (id) do update set role = excluded.role, display_name = excluded.display_name;

-- Check: this should print exactly two rows, one courier and one owner.
select p.display_name, p.role, u.email
from public.profiles p join auth.users u on u.id = p.id
order by p.role;
