# Mailbox

A two person web app for handling someone else's physical mail. One account (the
courier) picks up the mail, photographs it, and does what they are told. The
other account (the owner) looks at the photos and says what happens to each
piece: send it, hold it, throw it away, or open it and show me what is inside.

It is a plain static site. Add it to the iPhone home screen and it behaves like
an app. All the data lives in Supabase.

## How a piece of mail moves

```
courier photographs it        ->  awaiting_decision   (owner's turn)
owner picks an action         ->  action_needed       (courier's turn)
  forward / hold / discard    ->  courier marks done  ->  done
  open and photo / scan       ->  courier uploads contents
                              ->  awaiting_review     (owner's turn)
owner picks a final action    ->  action_needed       ->  done
```

The owner can also change their mind while the item is still on the courier, and
can list things they are expecting so the courier watches for them. A watch entry
can carry a photo of the thing, since he often has a picture of it before it
arrives. That is the one place the owner account may write to storage, and the
policy pins it to the `watch/` prefix so it still cannot touch mail photos.

While an item sits with the courier, the owner's card says what he asked for,
for example "Mustafa is on it · opening it for a scan".

Mail can be deleted from the courier's Mailbox tab, and watch entries from
either side. Deleting asks first, is permanent, and takes the image files out of
the bucket rather than orphaning them.

Every piece of mail also carries a note thread, either direction, so "email me
that scan please" is attached to the envelope it is about.

Both accounts see a countdown to the next mail run. The courier sets the
schedule and taps "I went today" to roll it forward. The owner can ask for an
earlier run, which the courier accepts or declines.

## Email notifications

Nothing sends one email per change. Triggers write every event to
`notify_events`, and a `pg_cron` job every ten minutes asks: is there anything
unsent, and is the oldest unsent thing older than the quiet window (an hour by
default, configurable in the app)? If so, everything since then goes out as a
single digest. Sixteen decisions become one email.

The courier's digest is ordered by how much work each decision costs, hardest
first: mail out, scan, photograph, hold, throw away. The owner's digest covers
new mail, things opened for him, and finished items. Both include any notes.
There is also a reminder on the morning of a mail run.

Delivery is a Google Apps Script web app that sends from a Gmail account. See
`tools/apps_script/Code.gs` for the script and its setup steps. Supabase posts
to it with a shared secret. The webhook url and secret live in `notify_channel`,
which has no select policy at all, so a signed in browser can set them but can
never read them back.

Everything is configured in the app under To do > Email notifications.

The owner's email is behind two switches, and both must be on. The courier owns
the master switch (`owner_enabled`, off by default), and the owner has his own
(`owner_opt_in`, on by default) under Mail > Email updates. If the master is
off, the owner's screen says so instead of offering a toggle that would do
nothing. The opt in defaults to on so that turning the master on is a single
action rather than a two person handshake.

## Security shape

- Two accounts, email and password. Public sign up is turned off, so those two
  logins are the only way in.
- Every table has row level security. Both accounts can read everything (it is
  one shared mailbox), but every write goes through a `security definer`
  function that checks the caller's role first. The owner account physically
  cannot file mail or move the schedule; the courier account cannot make
  decisions on his behalf.
- The photo bucket is private. Images are only ever fetched through signed URLs
  that last an hour and are minted for a signed in member.
- The anon key in `config.js` is public by design and grants nothing on its own.

## Where it lives

- Site: https://mustafaalbaree-uky.github.io/mailbox/
- Supabase project ref: `otruqvbnxjqmjstmmawf`
- Deploys on every push to `main` via `.github/workflows/pages.yml`

## Already done

The schema is applied, the private `mail` bucket exists, email signup is turned
off, and the site URL is set. `supabase/config.toml` and `supabase/migrations`
hold that state, so it can be rebuilt from scratch.

## Setup that is left

1. Authentication > Users > Add user, twice. Supabase asks for an email, so use
   `mustafa@mailbox.local` and `ayman@mailbox.local`. Set the passwords yourself
   and check "auto confirm". Signup is closed, so this is the only way an
   account can be made. Nobody ever types those addresses: the sign in screen
   asks for a username and the app appends `@mailbox.local` itself.
2. Run `supabase/create_users.sql` in the SQL editor. It prints two rows, one
   courier and one owner.
3. Open the site in Safari on both phones, Share, Add to Home Screen. Sign in
   once on each. The session persists, so nobody types a password again.

## Changing the schema later

```sh
supabase migration new some_change   # writes supabase/migrations/<stamp>_some_change.sql
supabase db push                     # applies it to the live project
supabase config push                 # applies auth and storage settings
```

The CLI lives at `~/.local/bin/supabase` (prebuilt binary, not Homebrew, because
this Mac's Command Line Tools are too old to build the tap).

## Local testing

```sh
cd ~/Code/mailbox
python3 -m http.server 8000
```

Then open http://localhost:8000. A service worker needs `localhost` or https, so
do not open `index.html` as a file.

## Files

| File | What it is |
| --- | --- |
| `index.html` | shell |
| `app.js` | the whole app, one file, no build step |
| `app.css` | styles, light and dark |
| `config.js` | your Supabase URL and anon key |
| `sw.js` | service worker, network first |
| `supabase/schema.sql` | tables, row level security, and the rpc functions |
| `supabase/create_users.sql` | links the two logins to their roles |
| `tools/make_icons.mjs` | regenerates the app icons |
