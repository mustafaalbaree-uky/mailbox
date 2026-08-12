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

## Setup

### 1. Supabase

1. Create a project at supabase.com (free tier is fine).
2. SQL Editor, paste all of `supabase/schema.sql`, run it.
3. Authentication > Users > Add user, twice: one for you, one for your uncle.
   Set passwords yourself and check "auto confirm".
4. Authentication > Sign In / Providers > Email: turn **off** "Allow new users to
   sign up". This is what keeps the app to two people.
5. SQL Editor, open `supabase/create_users.sql`, replace the two email addresses
   with the real ones, run it. It should print two rows, one courier and one
   owner.
6. Project Settings > API: copy the Project URL and the `anon public` key into
   `config.js`.

### 2. Hosting

Any static host works. With GitHub Pages:

```sh
cd ~/Code/mailbox
git init && git add -A && git commit -m "Mailbox"
gh repo create mailbox --private --source=. --push
```

Then Settings > Pages > Source: GitHub Actions. The included workflow publishes
on every push to `main`. A private repo needs a paid plan for Pages; if that is
a problem, make the repo public. The anon key is safe to publish, but do not
commit anything else.

### 3. On the phone

Open the Pages URL in Safari, Share, Add to Home Screen. Do the same on your
uncle's phone and sign him in once. The session persists, so he will not have to
type the password again.

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
