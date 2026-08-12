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
can list things they are expecting so the courier watches for them.

Both accounts see a countdown to the next mail run. The courier sets the
schedule and taps "I went today" to roll it forward. The owner can ask for an
earlier run, which the courier accepts or declines.

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

1. Authentication > Users > Add user, twice: one for you, one for your uncle.
   Set the passwords yourself and check "auto confirm". Signup is closed, so this
   is the only way an account can be made.
2. Put the two real emails into `supabase/create_users.sql` and run it in the SQL
   editor. It prints two rows, one courier and one owner.
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
