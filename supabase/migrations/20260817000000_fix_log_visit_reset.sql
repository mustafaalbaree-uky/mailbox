-- "I went today" should reset the countdown to interval_days from today,
-- not add interval_days on top of whatever next_visit_date already was.
create or replace function public.log_visit()
returns date language plpgsql security definer set search_path = public as $$
declare
  v_next date;
begin
  perform public.require_role('courier');
  update public.schedule set
    next_visit_date = current_date + interval_days,
    updated_at      = now(),
    updated_by      = auth.uid()
  where id = 1
  returning next_visit_date into v_next;
  return v_next;
end;
$$;
