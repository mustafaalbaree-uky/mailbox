// Variables used by Scriptable.
// These must be at the very top of the file. Comments below are used by Scriptable.
// icon-color: deep-blue; icon-glyph: envelope;
//
// Mailbox, a home screen widget for https://github.com/mustafaalbaree-uky/mailbox
//
// Shows the pieces of mail that are waiting on YOU, and how long until the next
// mail run. It works signed in as either account and asks the database which
// one you are, so the courier sees what he has to go do and the owner sees what
// he has to rule on.
//
// Setup
//   1. Scriptable > + > paste this in, name it "Mailbox".
//   2. Fill in USERNAME and PASSWORD below (the same ones you type in the app,
//      the username without "@mailbox.local").
//   3. Run it once inside Scriptable. It will sign in and show a preview.
//   4. Home screen > long press > + > Scriptable > Medium (or Large) > choose
//      this script, and set "When Interacting" to "Open URL" with the site url
//      if you want the tap to open the app.
//
// The password is read once and then kept in the iOS keychain, so you can blank
// it out again afterwards if you would rather it not sit in the script.

const USERNAME = "mustafa";
const PASSWORD = "";

const SUPABASE_URL = "https://otruqvbnxjqmjstmmawf.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90cnVxdmJueGpxbWpzdG1tYXdmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NjI2MzQsImV4cCI6MjEwMjEzODYzNH0.u4pMsVgzLPtwOO7cqSWfF_dLpPZihu-X-mEGLRP6vdY";
const APP_URL = "https://mustafaalbaree-uky.github.io/mailbox/";

const KEY_SESSION = "mailbox.widget.session";
const KEY_PASSWORD = "mailbox.widget.password";
const CACHE_FILE = "mailbox-widget-cache.json";

/* ----------------------------------------------------------------- wording */

// The five things the owner can ask for, said from each side's point of view.
const DECISION = {
  forward:    { courier: "Mail it to Ayman",     owner: "Sending it to you",     glyph: "✈️" },
  hold:       { courier: "Hold on to it",        owner: "Holding on to it",      glyph: "📦" },
  discard:    { courier: "Throw it away",        owner: "Throwing it away",      glyph: "🗑️" },
  open_photo: { courier: "Open and photograph",  owner: "Opening for a photo",   glyph: "📷" },
  open_scan:  { courier: "Open and scan",        owner: "Opening for a scan",    glyph: "🖨️" }
};

/* ------------------------------------------------------------------ colours */

const dyn = (light, dark) => Color.dynamic(new Color(light), new Color(dark));
const INK    = dyn("#14161a", "#f2f3f5");
const QUIET  = dyn("#6b7280", "#9aa1ab");
const RULE   = dyn("#d8dbe0", "#33373e");
const ACCENT = dyn("#1d63d1", "#77a8ff");
const WARN   = dyn("#b4470c", "#f0a35e");

/* -------------------------------------------------------------------- dates */

const startOfToday = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
};

// "2026-08-20" as a local day, not a UTC instant, so the count never slips one.
const parseDay = (s) => {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
};

const daysUntil = (s) => Math.round((parseDay(s) - startOfToday()) / 86400000);

const longDay = (s) =>
  parseDay(s).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

const countdownWords = (n) => {
  if (n < 0) return `Mail run was ${-n} day${-n === 1 ? "" : "s"} ago`;
  if (n === 0) return "Mail run is today";
  if (n === 1) return "Mail run is tomorrow";
  return `Mail run in ${n} days`;
};

/* ---------------------------------------------------------------- supabase */

// Everything is read as text and parsed here rather than through loadJSON.
// loadJSON goes through JSONSerialization, which rejects a bare top level value,
// so an rpc that answers `"courier"`, a perfectly good JSON string, comes back
// as "the data couldn't be read because it isn't in the correct format". Parsing
// in JavaScript accepts it, and a body that really is not JSON can then say what
// it actually was instead of hiding behind that same message.
async function send(url, { method, body, token } = {}) {
  const req = new Request(url);
  req.method = method || "GET";
  req.headers = {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`
  };
  if (body !== undefined) req.body = JSON.stringify(body);

  const text = await req.loadString();
  const status = req.response.statusCode;

  let data = null;
  if (text && text.trim()) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`HTTP ${status}: ${text.trim().slice(0, 80)}`);
    }
  }

  if (status >= 400) {
    const why = data && (data.error_description || data.msg || data.message || data.error);
    throw new Error(why || `HTTP ${status}`);
  }
  return data;
}

const post = (path, body, token) => send(`${SUPABASE_URL}${path}`, { method: "POST", body, token });
const get = (path, token) => send(`${SUPABASE_URL}/rest/v1/${path}`, { token });

function storedPassword() {
  // Typed into the script once, then it lives in the keychain instead.
  if (PASSWORD) {
    Keychain.set(KEY_PASSWORD, PASSWORD);
    return PASSWORD;
  }
  if (Keychain.contains(KEY_PASSWORD)) return Keychain.get(KEY_PASSWORD);
  throw new Error("No password yet. Put it in PASSWORD at the top and run once.");
}

function saveSession(s) {
  Keychain.set(
    KEY_SESSION,
    JSON.stringify({
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600)
    })
  );
  return s.access_token;
}

async function signIn() {
  const s = await post("/auth/v1/token?grant_type=password", {
    email: `${USERNAME}@mailbox.local`,
    password: storedPassword()
  });
  return saveSession(s);
}

// A widget refresh should almost never cost a full sign in: the saved token is
// good for an hour and the refresh token rolls it over after that.
async function token() {
  let saved = null;
  if (Keychain.contains(KEY_SESSION)) {
    try { saved = JSON.parse(Keychain.get(KEY_SESSION)); } catch (e) { saved = null; }
  }
  if (saved && saved.expires_at - 120 > Date.now() / 1000) return saved.access_token;
  if (saved && saved.refresh_token) {
    try {
      return saveSession(
        await post("/auth/v1/token?grant_type=refresh_token", { refresh_token: saved.refresh_token })
      );
    } catch (e) { /* fall through to a fresh sign in */ }
  }
  return signIn();
}

/* -------------------------------------------------------------------- data */

async function fetchState() {
  const t = await token();

  const [roleRows, schedule, items, requests, watching] = await Promise.all([
    post("/rest/v1/rpc/my_role", {}, t),
    get("schedule?select=next_visit_date,interval_days&id=eq.1", t),
    get(
      "mail_items?select=seq,label,status,decision,decision_note,created_at,updated_at" +
        "&status=in.(awaiting_decision,action_needed,awaiting_review)&order=updated_at.desc",
      t
    ),
    get("visit_requests?select=requested_date,reason&status=eq.pending&order=created_at.desc", t),
    get("watch_items?select=id&status=eq.watching", t)
  ]);

  // my_role() answers with a bare string, or null if this login was never
  // linked to a role by create_users.sql.
  const role = typeof roleRows === "string" ? roleRows : roleRows && roleRows.role;
  if (role !== "courier" && role !== "owner") {
    throw new Error(`${USERNAME} is signed in but has no role. Run create_users.sql.`);
  }
  const mine =
    role === "courier"
      ? items.filter((i) => i.status === "action_needed")
      : items.filter((i) => i.status === "awaiting_decision" || i.status === "awaiting_review");

  return {
    role,
    next_visit_date: schedule[0] ? schedule[0].next_visit_date : null,
    // A pending request is the courier's to answer and the owner's to wait on.
    request: requests[0] || null,
    watching: watching.length,
    items: mine.map((i) => ({
      seq: i.seq,
      label: i.label,
      status: i.status,
      decision: i.decision,
      note: i.decision_note
    })),
    fetched_at: Date.now()
  };
}

function cachePath() {
  const fm = FileManager.local();
  return fm.joinPath(fm.documentsDirectory(), CACHE_FILE);
}

function readCache() {
  const fm = FileManager.local();
  const p = cachePath();
  if (!fm.fileExists(p)) return null;
  try { return JSON.parse(fm.readString(p)); } catch (e) { return null; }
}

function writeCache(state) {
  FileManager.local().writeString(cachePath(), JSON.stringify(state));
}

/* ------------------------------------------------------------------ layout */

// Everything that is in your court, in one list, said from your side. The
// courier's pending visit request goes first: it is the only row with a date on
// it, so it is the one that goes stale if it waits behind five envelopes.
function courtRows(state) {
  const rows = [];

  if (state.role === "courier" && state.request) {
    rows.push({
      glyph: "📅",
      name: "Earlier run?",
      what: longDay(state.request.requested_date),
      note: state.request.reason
    });
  }

  for (const item of state.items) {
    const name = "#" + item.seq + (item.label ? " " + item.label : "");
    if (state.role === "courier") {
      const d = DECISION[item.decision];
      rows.push({ glyph: d ? d.glyph : "✉️", name, what: d ? d.courier : "Waiting on you", note: item.note });
    } else if (item.status === "awaiting_review") {
      rows.push({ glyph: "📄", name, what: "Opened, your call", note: null });
    } else {
      rows.push({ glyph: "✉️", name, what: "New, needs your call", note: null });
    }
  }

  return rows;
}

function addRow(stack, row, wide) {
  const line = stack.addStack();
  line.centerAlignContent();
  line.spacing = 6;

  const g = line.addText(row.glyph);
  g.font = Font.systemFont(13);

  const name = line.addText(row.name);
  name.font = Font.semiboldSystemFont(13);
  name.textColor = INK;
  name.lineLimit = 1;

  line.addSpacer();

  const what = line.addText(wide && row.note ? `${row.what} · ${row.note}` : row.what);
  what.font = Font.systemFont(12);
  what.textColor = QUIET;
  what.lineLimit = 1;
  what.rightAlignText();
}

function buildWidget(state, size, stale) {
  const w = new ListWidget();
  w.url = APP_URL;
  w.backgroundColor = dyn("#ffffff", "#111318");
  w.setPadding(14, 14, 12, 14);

  const small = size === "small";
  const rowCap = size === "large" ? 9 : size === "medium" ? 4 : 0;
  const court = courtRows(state);

  /* header: the countdown, which is the thing worth seeing at a glance */
  const days = state.next_visit_date == null ? null : daysUntil(state.next_visit_date);
  const head = w.addStack();
  head.centerAlignContent();
  head.spacing = 5;

  const icon = head.addText("📬");
  icon.font = Font.systemFont(small ? 15 : 14);

  const title = head.addText(days == null ? "No mail run set" : countdownWords(days));
  title.font = Font.semiboldSystemFont(small ? 13 : 14);
  title.textColor = days != null && days <= 0 ? WARN : INK;
  title.lineLimit = 1;

  if (!small) {
    head.addSpacer();
    const badge = head.addText(String(court.length));
    badge.font = Font.boldSystemFont(15);
    badge.textColor = court.length ? ACCENT : QUIET;
  }

  const sub = w.addText(
    state.next_visit_date == null
      ? "Set the schedule in the app"
      : longDay(state.next_visit_date)
  );
  sub.font = Font.systemFont(11);
  sub.textColor = QUIET;
  sub.lineLimit = 1;

  if (small) {
    w.addSpacer();
    const n = w.addText(String(court.length));
    n.font = Font.boldSystemFont(38);
    n.textColor = court.length ? ACCENT : QUIET;
    const cap = w.addText(court.length === 1 ? "thing on you" : "things on you");
    cap.font = Font.systemFont(12);
    cap.textColor = QUIET;
    w.addSpacer();
    return w;
  }

  w.addSpacer(8);
  const rule = w.addStack();
  rule.size = new Size(0, 1);
  rule.backgroundColor = RULE;
  rule.addSpacer();
  w.addSpacer(8);

  /* the list itself */
  const rows = w.addStack();
  rows.layoutVertically();
  rows.spacing = 6;

  const shown = court.slice(0, rowCap);
  const wide = size === "large";

  if (!shown.length) {
    const clear = rows.addText(
      state.role === "courier" ? "Nothing to go do. Clear." : "Nothing waiting on you. Clear."
    );
    clear.font = Font.systemFont(13);
    clear.textColor = QUIET;
  } else {
    shown.forEach((row) => addRow(rows, row, wide));
  }

  w.addSpacer();

  /* footer: what is not on screen, and how fresh this is */
  const foot = w.addStack();
  foot.centerAlignContent();

  const hidden = court.length - shown.length;
  const bits = [];
  if (hidden > 0) bits.push(`+${hidden} more`);
  if (state.role === "courier" && state.watching) bits.push(`watching for ${state.watching}`);
  const left = foot.addText(bits.join(" · "));
  left.font = Font.systemFont(10);
  left.textColor = QUIET;

  foot.addSpacer();

  const when = new Date(state.fetched_at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
  const right = foot.addText(stale ? `offline · ${when}` : when);
  right.font = Font.systemFont(10);
  right.textColor = stale ? WARN : QUIET;

  return w;
}

function errorWidget(message) {
  const w = new ListWidget();
  w.url = APP_URL;
  w.backgroundColor = dyn("#ffffff", "#111318");
  const t = w.addText("📬 Mailbox");
  t.font = Font.semiboldSystemFont(14);
  t.textColor = INK;
  w.addSpacer(6);
  const m = w.addText(message);
  m.font = Font.systemFont(11);
  m.textColor = WARN;
  return w;
}

/* --------------------------------------------------------------------- run */

const size = config.widgetFamily || "medium";
let widget;

try {
  const state = await fetchState();
  writeCache(state);
  widget = buildWidget(state, size, false);
} catch (e) {
  // A widget that goes blank the moment the phone loses signal is worse than
  // one that shows this morning's list with the time it was fetched.
  const cached = readCache();
  widget = cached ? buildWidget(cached, size, true) : errorWidget(String(e.message || e));
}

// Ask iOS for a refresh in fifteen minutes. It treats this as a hint.
widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

if (config.runsInWidget) {
  Script.setWidget(widget);
} else if (size === "large") {
  widget.presentLarge();
} else if (size === "small") {
  widget.presentSmall();
} else {
  widget.presentMedium();
}
Script.complete();
