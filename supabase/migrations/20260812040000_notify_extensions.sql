-- Outbound http (to hand an email to a Google Apps Script webhook) and a
-- scheduler (to fire the batched digests without anything running on a laptop).
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
