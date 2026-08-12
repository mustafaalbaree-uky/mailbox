import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const cfg = window.MAILBOX_CONFIG || {};
if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("REPLACE_ME")) {
  document.getElementById("boot").textContent =
    "config.js has not been filled in yet. Add your Supabase URL and anon key.";
  throw new Error("missing config");
}

const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

/* ------------------------------------------------------------------ state */

const S = {
  session: null,
  profile: null,
  tab: null,
  items: [],
  photos: new Map(),   // item id -> photo rows
  notes: new Map(),    // item id -> note rows
  people: new Map(),   // user id -> display name
  watch: [],
  schedule: null,
  requests: [],
  notify: null,
  staged: []           // photos picked but not yet filed
};

const $boot = document.getElementById("boot");
const $app = document.getElementById("app");
const $topbar = document.getElementById("topbar");
const $view = document.getElementById("view");
const $tabs = document.getElementById("tabs");

const isCourier = () => S.profile?.role === "courier";

/* ---------------------------------------------------------------- helpers */

const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of [].concat(kids)) if (kid) n.append(kid);
  return n;
};

const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

function toast(msg, bad = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, bad ? 5200 : 2600);
}

function busy(text) {
  const b = document.getElementById("busy");
  if (text === false) { b.hidden = true; return; }
  document.getElementById("busy-text").textContent = text || "";
  b.hidden = false;
}

async function guard(text, fn) {
  busy(text);
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(err?.message || "Something went wrong", true);
    return null;
  } finally {
    busy(false);
  }
}

// "2026-08-19" as a local date, not a UTC one.
const parseDay = (s) => {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
};
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const daysUntil = (s) => Math.round((parseDay(s) - today()) / 86400000);
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const longDay = (s) => parseDay(s).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const shortWhen = (ts) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const DECISION = {
  forward:    { owner: "Send it to me",              courier: "Mail it to Ayman",            glyph: "✈️" },
  hold:       { owner: "Hold on to it",              courier: "Put it in Ayman's box",         glyph: "📦" },
  discard:    { owner: "Throw it away",              courier: "Throw it away",             glyph: "🗑️" },
  open_photo: { owner: "Open it, send me a photo",   courier: "Open it and photograph it", glyph: "📷" },
  open_scan:  { owner: "Open it, send me a scan",    courier: "Open it and scan it",       glyph: "🖨️" }
};
const DISPOSITION = { forwarded: "Mailed out", held: "Held here", discarded: "Thrown away" };

// What the owner sees on an item he has already ruled on, so the pill says both
// that Mustafa has it and which of the five things he was asked to do.
const IN_PROGRESS = {
  forward:    "sending it to you",
  hold:       "holding on to it",
  discard:    "throwing it away",
  open_photo: "opening it for a photo",
  open_scan:  "opening it for a scan"
};

/* ------------------------------------------------------------ signed urls */

const urlCache = new Map();

async function signPaths(paths) {
  const now = Date.now();
  const need = [...new Set(paths)].filter((p) => {
    const hit = urlCache.get(p);
    return !hit || hit.until - now < 300000;
  });
  for (let i = 0; i < need.length; i += 50) {
    const batch = need.slice(i, i + 50);
    const { data, error } = await sb.storage.from("mail").createSignedUrls(batch, 3600);
    if (error) throw error;
    data.forEach((row, n) => {
      if (row.signedUrl) urlCache.set(row.path || batch[n], { url: row.signedUrl, until: now + 3500000 });
    });
  }
  return paths.map((p) => urlCache.get(p)?.url);
}

/* ------------------------------------------------------------------- data */

async function loadAll() {
  const [items, watch, schedule, requests, people, notify] = await Promise.all([
    sb.from("mail_items").select("*").order("created_at", { ascending: false }).limit(200),
    sb.from("watch_items").select("*").order("created_at", { ascending: false }),
    sb.from("schedule").select("*").eq("id", 1).single(),
    sb.from("visit_requests").select("*").order("created_at", { ascending: false }).limit(10),
    sb.from("profiles").select("id, display_name, role"),
    sb.from("notify_config").select("*").eq("id", 1).single()
  ]);
  for (const r of [items, watch, schedule, requests, people, notify]) if (r.error) throw r.error;

  S.items = items.data;
  S.watch = watch.data;
  S.schedule = schedule.data;
  S.requests = requests.data;
  S.notify = notify.data;
  S.people = new Map((people.data || []).map((p) => [p.id, p.display_name]));

  const ids = S.items.map((i) => i.id);
  S.photos = new Map();
  S.notes = new Map();
  if (ids.length) {
    const [photos, notes] = await Promise.all([
      sb.from("item_photos").select("*").in("item_id", ids).order("created_at"),
      sb.from("item_notes").select("*").in("item_id", ids).order("created_at")
    ]);
    if (photos.error) throw photos.error;
    if (notes.error) throw notes.error;
    for (const p of photos.data) {
      if (!S.photos.has(p.item_id)) S.photos.set(p.item_id, []);
      S.photos.get(p.item_id).push(p);
    }
    for (const n of notes.data) {
      if (!S.notes.has(n.item_id)) S.notes.set(n.item_id, []);
      S.notes.get(n.item_id).push(n);
    }
  }
}

async function refresh(quiet = true) {
  try {
    await loadAll();
    render();
  } catch (err) {
    console.error(err);
    if (!quiet) toast(err.message || "Could not load", true);
  }
}

/* -------------------------------------------------------------- item view */

const needsOwner = (i) => i.status === "awaiting_decision" || i.status === "awaiting_review";
const needsCourier = (i) => i.status === "action_needed";
const myTurn = (i) => (isCourier() ? needsCourier(i) : needsOwner(i));

function statusPill(item) {
  if (item.status === "done") {
    return el("span", { class: "pill done", text: DISPOSITION[item.final_disposition] || "Done" });
  }
  if (myTurn(item)) {
    const label = item.status === "action_needed"
      ? DECISION[item.decision]?.courier || "Your move"
      : item.status === "awaiting_review" ? "Opened, your call" : "Needs your call";
    return el("span", { class: "pill you", text: label });
  }
  if (item.status === "action_needed") {
    const doing = IN_PROGRESS[item.decision];
    return el("span", {
      class: doing ? "pill wait long" : "pill wait",
      text: doing ? `Mustafa is on it · ${doing}` : "Mustafa is on it"
    });
  }
  return el("span", { class: "pill wait", text: "Waiting on Ayman" });
}

function photoStrip(item, kind) {
  const shots = (S.photos.get(item.id) || []).filter((p) => p.kind === kind);
  if (!shots.length) return null;
  const strip = el("div", { class: "shots" + (shots.length === 1 ? " one" : "") });
  shots.forEach((p) => {
    const img = el("img", { alt: kind === "contents" ? "Contents" : "Envelope", loading: "lazy" });
    img.addEventListener("click", () => lightbox(shots.map((x) => x.path), shots.indexOf(p)));
    strip.append(img);
    signPaths([p.path]).then(([url]) => { if (url) img.src = url; });
  });
  return strip;
}

function itemCard(item, actions) {
  const card = el("div", { class: "card" });
  const envelopes = photoStrip(item, "envelope");
  if (envelopes) card.append(envelopes);

  const contents = photoStrip(item, "contents");
  if (contents) {
    card.append(el("div", { class: "shot-group", text: "Inside" }));
    card.append(contents);
  }

  const body = el("div", { class: "card-body" });
  const top = el("div", { class: "card-top" });
  top.append(statusPill(item));
  // The number is how an emailed digest and this card refer to the same envelope.
  if (item.seq) top.append(el("span", { class: "card-seq", text: "#" + item.seq }));
  body.append(top);
  if (item.label) body.append(el("div", { class: "card-label", text: item.label }));
  if (item.courier_note) body.append(el("div", { class: "card-note", text: item.courier_note }));
  if (item.decision_note) body.append(el("div", { class: "card-note", text: "“" + item.decision_note + "”" }));
  body.append(el("div", { class: "card-meta", text: "Picked up " + shortWhen(item.created_at) }));
  card.append(body);
  card.append(notesBlock(item));

  if (actions) card.append(actions);
  return card;
}

// A back and forth against one envelope, so "email me that scan" is attached to
// the thing it is about instead of arriving as a text message with no context.
function notesBlock(item) {
  const wrap = el("div", { class: "notes" });
  for (const n of S.notes.get(item.id) || []) {
    const line = el("div", { class: "note" + (n.author === S.session.user.id ? " mine" : "") });
    line.append(el("span", { class: "note-who", text: S.people.get(n.author) || "Someone" }));
    line.append(document.createTextNode(" " + n.body));
    line.append(el("span", { class: "note-when", text: shortWhen(n.created_at) }));
    wrap.append(line);
  }
  wrap.append(el("button", {
    class: "btn-quiet note-add",
    text: (S.notes.get(item.id) || []).length ? "Add another note" : "Add a note",
    onclick: () => addNote(item)
  }));
  return wrap;
}

function addNote(item) {
  sheet(item.label ? `Note on ${item.label}` : "Note on this piece", (panel, close) => {
    const body = el("textarea", { placeholder: "e.g. please email me that scan" });
    panel.append(body);
    panel.append(el("button", {
      class: "btn-main btn-center",
      text: "Add the note",
      onclick: async () => {
        if (!body.value.trim()) { toast("Write something first", true); return; }
        close();
        const ok = await guard("Saving", async () => {
          const { error } = await sb.from("item_notes").insert({
            item_id: item.id, author: S.session.user.id, body: body.value.trim()
          });
          if (error) throw error;
          return true;
        });
        if (ok) { toast("Note added"); await refresh(); }
      }
    }));
  });
}

/* ------------------------------------------------------------- lightbox */

async function lightbox(paths, index) {
  const box = document.getElementById("lightbox");
  clear(box);
  box.hidden = false;
  let i = index;
  const img = el("img", { alt: "Mail photo" });
  const show = async () => { const [u] = await signPaths([paths[i]]); img.src = u; };
  box.append(img);
  box.append(el("button", { class: "close", text: "✕", onclick: () => { box.hidden = true; } }));
  if (paths.length > 1) {
    img.addEventListener("click", () => { i = (i + 1) % paths.length; show(); });
  }
  show();
}

/* ------------------------------------------------------------ bottom sheet */

function sheet(title, build) {
  const wrap = document.getElementById("sheet");
  clear(wrap);
  const panel = el("div", { class: "sheet" });
  const close = () => { wrap.hidden = true; };
  panel.append(el("h2", { text: title }));
  build(panel, close);
  panel.append(el("button", { class: "btn-quiet btn-center", text: "Cancel", onclick: close }));
  panel.addEventListener("click", (e) => e.stopPropagation());
  wrap.append(panel);
  wrap.onclick = close;
  wrap.hidden = false;
  return close;
}

/* --------------------------------------------------------------- photos */

function pickFiles({ camera }) {
  return new Promise((resolve) => {
    const input = el("input", { type: "file", accept: "image/*", multiple: !camera });
    if (camera) input.setAttribute("capture", "environment");
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve([...input.files]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

// Phone photos are 3 to 5 MB each. Resize to something that still reads a
// return address but uploads in a second or two on cell service.
function compress(file, max = 1800, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = el("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not read that photo"))), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that photo")); };
    img.src = url;
  });
}

async function uploadBlobs(blobs, onProgress, prefix) {
  const stamp = prefix || isoDay(new Date()).slice(0, 7);
  const paths = [];
  for (const [n, blob] of blobs.entries()) {
    if (onProgress) onProgress(n + 1, blobs.length);
    const path = `${stamp}/${crypto.randomUUID()}.jpg`;
    const { error } = await sb.storage.from("mail").upload(path, blob, { contentType: "image/jpeg" });
    if (error) throw error;
    paths.push(path);
  }
  return paths;
}

async function stageFrom({ camera }) {
  const files = await pickFiles({ camera });
  if (!files.length) return;
  await guard("Preparing photos", async () => {
    for (const f of files) {
      const blob = await compress(f);
      S.staged.push({ blob, url: URL.createObjectURL(blob) });
    }
  });
  render();
}

/* ---------------------------------------------------------------- actions */

async function decide(item, decision) {
  sheet(DECISION[decision].owner, (panel, close) => {
    const note = el("textarea", { placeholder: "Anything to add for Mustafa? (optional)" });
    panel.append(note);
    panel.append(el("button", {
      class: "btn-main btn-center",
      text: "Confirm",
      onclick: async () => {
        close();
        const ok = await guard("Sending", async () => {
          const { error } = await sb.rpc("set_decision", {
            p_item: item.id, p_decision: decision, p_note: note.value
          });
          if (error) throw error;
          return true;
        });
        if (ok) { toast("Mustafa has been told"); await refresh(); }
      }
    }));
  });
}

async function completeItem(item) {
  const map = { forward: "forwarded", hold: "held", discard: "discarded" };
  const ok = await guard("Saving", async () => {
    const { error } = await sb.rpc("complete_item", { p_item: item.id, p_disposition: map[item.decision] });
    if (error) throw error;
    return true;
  });
  if (ok) { toast("Marked done"); await refresh(); }
}

async function addContents(item) {
  const files = await pickFiles({ camera: false });
  if (!files.length) return;
  const ok = await guard("Uploading", async () => {
    const blobs = [];
    for (const f of files) blobs.push(await compress(f, 2200, 0.86));
    const paths = await uploadBlobs(blobs, (n, total) => busy(`Uploading ${n} of ${total}`));
    const { error } = await sb.rpc("mark_opened", { p_item: item.id, p_paths: paths });
    if (error) throw error;
    return true;
  });
  if (ok) { toast("Sent to Ayman for a look"); await refresh(); }
}

async function fileStaged({ separate, label, note }) {
  const ok = await guard("Uploading", async () => {
    if (separate) {
      for (const [n, shot] of S.staged.entries()) {
        busy(`Uploading ${n + 1} of ${S.staged.length}`);
        const paths = await uploadBlobs([shot.blob]);
        const { error } = await sb.rpc("file_mail_item", { p_label: label || null, p_note: note || null, p_paths: paths });
        if (error) throw error;
      }
    } else {
      const paths = await uploadBlobs(S.staged.map((s) => s.blob), (n, t) => busy(`Uploading ${n} of ${t}`));
      const { error } = await sb.rpc("file_mail_item", { p_label: label || null, p_note: note || null, p_paths: paths });
      if (error) throw error;
    }
    return true;
  });
  if (ok) {
    const count = separate ? S.staged.length : 1;
    S.staged.forEach((s) => URL.revokeObjectURL(s.url));
    S.staged = [];
    toast(count === 1 ? "Added to Ayman's mailbox" : `${count} items added`);
    S.tab = "mailbox";
    await refresh();
  }
}

/* ------------------------------------------------------------- top bar */

function renderTopbar() {
  clear($topbar);
  $topbar.append(el("div", { class: "bar-row" }, [
    el("div", { class: "bar-title", text: "Mailbox" }),
    el("button", {
      class: "btn-quiet bar-who",
      style: "border:0;padding:0;background:none",
      text: S.profile.display_name + " · sign out",
      onclick: async () => {
        // Without this the saved password would just sign straight back in.
        forgetLogin();
        await sb.auth.signOut();
        location.reload();
      }
    })
  ]));

  if (!S.schedule) return;
  const days = daysUntil(S.schedule.next_visit_date);
  const headline = days <= 0 ? "Mail run today" : days === 1 ? "Mail run tomorrow" : `${days} days until the next mail run`;
  $topbar.append(el("div", { class: "countdown" }, [
    document.createTextNode(headline),
    el("small", { text: longDay(S.schedule.next_visit_date) + " · every " + S.schedule.interval_days + " days" })
  ]));
}

/* ------------------------------------------------------------ owner view */

function ownerMailView() {
  const frag = document.createDocumentFragment();

  const pending = S.requests.find((r) => r.status === "pending");
  if (pending) {
    frag.append(el("div", { class: "banner" }, [
      el("strong", { text: "You asked for an earlier run" }),
      el("div", { class: "card-note", text: longDay(pending.requested_date) + ". Waiting on Mustafa to confirm." })
    ]));
  }

  // Kept above the mail itself: anything below a long column of photos is
  // effectively hidden.
  const topRow = el("div", { class: "row" });
  if (!pending) {
    topRow.append(el("button", { class: "btn-quiet btn-center", text: "Ask for an earlier run", onclick: askSooner }));
  }
  topRow.append(el("button", { class: "btn-quiet btn-center", text: "✉️  Email updates", onclick: ownerNotifySettings }));
  frag.append(topRow);

  const mine = S.items.filter(needsOwner);
  const working = S.items.filter(needsCourier);
  const done = S.items.filter((i) => i.status === "done").slice(0, 12);

  frag.append(el("div", { class: "section-title", text: mine.length ? "Waiting on you" : "Nothing waiting on you" }));
  if (!mine.length) {
    frag.append(el("div", { class: "empty", text: "You are all caught up." }));
  }
  for (const item of mine) frag.append(itemCard(item, ownerChoices(item)));

  if (working.length) {
    frag.append(el("div", { class: "section-title", text: "Mustafa is handling" }));
    for (const item of working) {
      frag.append(itemCard(item, el("div", { class: "choices" }, [
        el("button", { class: "btn-quiet btn-center", text: "Change my mind", onclick: () => undo(item) })
      ])));
    }
  }

  if (done.length) {
    frag.append(el("div", { class: "section-title", text: "Finished" }));
    for (const item of done) frag.append(itemCard(item, null));
  }

  return frag;
}

// Ayman's own switch. It only does anything when Mustafa has turned email on
// from his side, so the sheet says plainly which state it is in rather than
// offering a toggle that quietly does nothing.
function ownerNotifySettings() {
  const cfg = S.notify || {};
  const masterOn = !!cfg.owner_enabled;

  sheet("Email updates", (panel, close) => {
    if (!masterOn) {
      panel.append(el("p", { class: "card-note", text:
        "Mustafa has not switched these on yet. Tell him you want them and he can turn them on from his phone." }));
      return;
    }

    panel.append(el("p", { class: "card-note", text:
      "One email when Mustafa adds mail or finishes something, never one per change." }));

    const box = el("input", { type: "checkbox" });
    box.checked = cfg.owner_opt_in ?? true;
    const row = el("label", { class: "toggle" }, [box]);
    row.append(document.createTextNode(" Send me email updates"));
    panel.append(row);

    const email = el("input", { type: "email", placeholder: "you@example.com", value: cfg.owner_email || "" });
    panel.append(el("label", { class: "field", text: "Send them to" }));
    panel.append(email);

    panel.append(el("button", {
      class: "btn-main btn-center",
      text: "Save",
      onclick: async () => {
        close();
        const ok = await guard("Saving", async () => {
          const { error } = await sb.rpc("set_owner_notify", {
            p_on: box.checked, p_email: email.value
          });
          if (error) throw error;
          return true;
        });
        if (ok) { toast(box.checked ? "Emails are on" : "Emails are off"); await refresh(); }
      }
    }));
  });
}

function ownerChoices(item) {
  const opened = item.status === "awaiting_review";
  const keys = opened ? ["forward", "hold", "discard", "open_scan"] : ["open_photo", "open_scan", "forward", "hold", "discard"];
  const box = el("div", { class: "choices" });
  for (const k of keys) {
    if (opened && k === "open_scan" && (S.photos.get(item.id) || []).some((p) => p.kind === "contents")) {
      // Only offer the upgrade to a real scan once, and only as a quiet option.
      box.append(el("button", { class: "btn-quiet", text: "Send me a proper scan of it", onclick: () => decide(item, k) }));
      continue;
    }
    box.append(el("button", {
      class: k === "discard" ? "btn-danger" : "",
      onclick: () => decide(item, k)
    }, [document.createTextNode(DECISION[k].glyph + "  " + DECISION[k].owner)]));
  }
  return box;
}

async function undo(item) {
  const ok = await guard("Undoing", async () => {
    const { error } = await sb.rpc("undo_decision", { p_item: item.id });
    if (error) throw error;
    return true;
  });
  if (ok) { toast("Back to you"); await refresh(); }
}

function askSooner() {
  sheet("Ask for an earlier run", (panel, close) => {
    const date = el("input", { type: "date", value: isoDay(new Date(Date.now() + 86400000)), min: isoDay(today()) });
    const why = el("textarea", { placeholder: "What are you waiting on? (optional)" });
    panel.append(el("label", { class: "field", text: "When do you need it?" }));
    panel.append(date);
    panel.append(why);
    panel.append(el("button", {
      class: "btn-main btn-center",
      text: "Send the request",
      onclick: async () => {
        close();
        const ok = await guard("Sending", async () => {
          const { error } = await sb.rpc("request_visit", { p_date: date.value, p_reason: why.value });
          if (error) throw error;
          return true;
        });
        if (ok) { toast("Request sent"); await refresh(); }
      }
    }));
  });
}

function watchView() {
  const frag = document.createDocumentFragment();
  const owner = !isCourier();

  if (owner) {
    frag.append(el("button", { class: "btn-main btn-center", text: "Add something to watch for", onclick: addWatch }));
  }

  const live = S.watch.filter((w) => w.status === "watching");
  const past = S.watch.filter((w) => w.status !== "watching").slice(0, 10);

  frag.append(el("div", { class: "section-title", text: "Watching for" }));
  if (!live.length) {
    frag.append(el("div", {
      class: "empty",
      text: owner ? "Nothing yet. Add anything you are expecting so Mustafa keeps an eye out."
                  : "Ayman is not waiting on anything in particular."
    }));
  }
  for (const w of live) {
    const card = el("div", { class: "card" });
    if (w.photo_path) {
      const strip = el("div", { class: "shots one" });
      const img = el("img", { alt: "What to look for", loading: "lazy" });
      img.addEventListener("click", () => lightbox([w.photo_path], 0));
      strip.append(img);
      signPaths([w.photo_path]).then(([url]) => { if (url) img.src = url; });
      card.append(strip);
    }
    const body = el("div", { class: "card-body" });
    body.append(el("div", { class: "card-label", text: w.description }));
    if (w.details) body.append(el("div", { class: "card-note", text: w.details }));
    body.append(el("div", { class: "card-meta", text: "Added " + shortWhen(w.created_at) }));
    card.append(body);
    card.append(el("div", { class: "choices two" }, [
      el("button", { class: "btn-quiet btn-center", text: "It came in", onclick: () => resolveWatch(w, "found") }),
      el("button", { class: "btn-quiet btn-center", text: "Never mind", onclick: () => resolveWatch(w, "cancelled") })
    ]));
    card.append(el("div", { class: "choices" }, [
      el("button", { class: "btn-quiet btn-center", text: "Delete", onclick: () => deleteWatch(w) })
    ]));
    frag.append(card);
  }

  if (past.length) {
    frag.append(el("div", { class: "section-title", text: "Closed out" }));
    for (const w of past) {
      frag.append(el("div", { class: "card" }, [
        el("div", { class: "card-body" }, [
          el("span", { class: "pill", text: w.status === "found" ? "Arrived" : "Called off" }),
          el("div", { class: "card-label", text: w.description })
        ]),
        el("div", { class: "choices" }, [
          el("button", { class: "btn-quiet btn-center", text: "Delete", onclick: () => deleteWatch(w) })
        ])
      ]));
    }
  }
  return frag;
}

function addWatch() {
  sheet("Watch for something", (panel, close) => {
    const what = el("input", { type: "text", placeholder: "e.g. new debit card from Chase" });
    const more = el("textarea", { placeholder: "Anything that helps Mustafa spot it (optional)" });
    panel.append(el("label", { class: "field", text: "What are you expecting?" }));
    panel.append(what);
    panel.append(more);

    // A picture of the thing, if he has one, so Mustafa knows it on sight.
    let shot = null;
    const preview = el("div", { class: "staged" });
    const addPhoto = el("button", { class: "btn-quiet btn-center", text: "📷  Add a photo of it" });
    const drawPreview = () => {
      clear(preview);
      addPhoto.textContent = shot ? "📷  Use a different photo" : "📷  Add a photo of it";
      if (!shot) return;
      preview.append(el("figure", {}, [
        el("img", { src: shot.url, alt: "What to look for" }),
        el("button", {
          text: "✕",
          onclick: () => { URL.revokeObjectURL(shot.url); shot = null; drawPreview(); }
        })
      ]));
    };
    addPhoto.addEventListener("click", async () => {
      const files = await pickFiles({ camera: false });
      if (!files.length) return;
      await guard("Preparing photo", async () => {
        if (shot) URL.revokeObjectURL(shot.url);
        const blob = await compress(files[0]);
        shot = { blob, url: URL.createObjectURL(blob) };
      });
      drawPreview();
    });
    panel.append(addPhoto);
    panel.append(preview);

    panel.append(el("button", {
      class: "btn-main btn-center",
      text: "Add it",
      onclick: async () => {
        if (!what.value.trim()) { toast("Give it a short name first", true); return; }
        close();
        const ok = await guard("Saving", async () => {
          let path = null;
          if (shot) {
            busy("Uploading the photo");
            [path] = await uploadBlobs([shot.blob], null, "watch");
          }
          const { error } = await sb.from("watch_items").insert({
            description: what.value.trim(),
            details: more.value.trim() || null,
            photo_path: path,
            created_by: S.session.user.id
          });
          if (error) throw error;
          return true;
        });
        if (ok) {
          if (shot) URL.revokeObjectURL(shot.url);
          toast("Added");
          await refresh();
        }
      }
    }));
  });
}

// Deleting is for clearing out test runs and mistakes. It is permanent, so it
// always asks first, and it takes the image files with it rather than leaving
// them orphaned in the bucket.
function confirmDelete({ title, warning, run }) {
  sheet(title, (panel, close) => {
    panel.append(el("p", { class: "card-note", text: warning }));
    panel.append(el("button", {
      class: "btn-danger btn-center",
      text: "Delete for good",
      onclick: async () => {
        close();
        const ok = await guard("Deleting", async () => {
          const { data, error } = await run();
          if (error) throw error;
          const paths = (data || []).filter(Boolean);
          if (paths.length) await sb.storage.from("mail").remove(paths);
          return true;
        });
        if (ok) { toast("Deleted"); await refresh(); }
      }
    }));
  });
}

const deleteItem = (item) => confirmDelete({
  title: item.label ? `Delete "${item.label}"?` : "Delete this piece of mail?",
  warning: "This removes it and its photos for both of you. It cannot be undone.",
  run: () => sb.rpc("delete_mail_item", { p_item: item.id })
});

const deleteWatch = (w) => confirmDelete({
  title: `Delete "${w.description}"?`,
  warning: "This removes the entry and its photo for both of you. It cannot be undone.",
  run: () => sb.rpc("delete_watch_item", { p_watch: w.id })
});

async function resolveWatch(w, status) {
  const ok = await guard("Saving", async () => {
    const { error } = await sb.rpc("resolve_watch", { p_watch: w.id, p_status: status, p_item: null });
    if (error) throw error;
    return true;
  });
  if (ok) await refresh();
}

/* ---------------------------------------------------------- courier view */

function courierTodoView() {
  const frag = document.createDocumentFragment();

  const pending = S.requests.find((r) => r.status === "pending");
  if (pending) {
    const banner = el("div", { class: "banner" }, [
      el("strong", { text: "Ayman is asking for an earlier run" }),
      el("div", { class: "card-note", text: longDay(pending.requested_date) + (pending.reason ? " · " + pending.reason : "") })
    ]);
    banner.append(el("div", { class: "row" }, [
      el("button", { class: "btn-main btn-center", text: "That works", onclick: () => respondRequest(pending, true) }),
      el("button", { class: "btn-quiet btn-center", text: "Cannot", onclick: () => respondRequest(pending, false) })
    ]));
    frag.append(banner);
  }

  frag.append(el("div", { class: "row" }, [
    el("button", { class: "btn-quiet btn-center", text: "I went today", onclick: logVisit }),
    el("button", { class: "btn-quiet btn-center", text: "Change schedule", onclick: editSchedule })
  ]));
  frag.append(el("button", { class: "btn-quiet btn-center", text: "✉️  Email notifications", onclick: notifySettings }));

  const todo = S.items.filter(needsCourier);
  frag.append(el("div", { class: "section-title", text: todo.length ? "To do" : "Nothing to do" }));
  if (!todo.length) frag.append(el("div", { class: "empty", text: "No requests from Ayman right now." }));

  for (const item of todo) {
    const box = el("div", { class: "choices" });
    if (item.decision === "open_photo" || item.decision === "open_scan") {
      box.append(el("button", {
        class: "btn-main btn-center",
        text: item.decision === "open_scan" ? "Attach the scan" : "Attach photos of the contents",
        onclick: () => addContents(item)
      }));
    } else {
      box.append(el("button", {
        class: "btn-main btn-center",
        text: DECISION[item.decision]?.courier + " · done",
        onclick: () => completeItem(item)
      }));
    }
    frag.append(itemCard(item, box));
  }
  return frag;
}

function courierAddView() {
  const frag = document.createDocumentFragment();

  frag.append(el("div", { class: "row" }, [
    el("button", { class: "btn-main btn-center", text: "📷 Camera", onclick: () => stageFrom({ camera: true }) }),
    el("button", { class: "btn-quiet btn-center", text: "Choose photos", onclick: () => stageFrom({ camera: false }) })
  ]));

  if (!S.staged.length) {
    frag.append(el("div", {
      class: "empty",
      text: "Shoot one photo per envelope. Take them all now, then send the batch in one go."
    }));
    return frag;
  }

  const strip = el("div", { class: "staged" });
  S.staged.forEach((shot, n) => {
    strip.append(el("figure", {}, [
      el("img", { src: shot.url, alt: "Staged photo" }),
      el("button", { text: "✕", onclick: () => { URL.revokeObjectURL(shot.url); S.staged.splice(n, 1); render(); } })
    ]));
  });
  frag.append(strip);

  const label = el("input", { type: "text", placeholder: "Optional label, e.g. Chase Bank" });
  const note = el("textarea", { placeholder: "Optional note for Ayman" });
  const many = S.staged.length > 1;

  if (many) {
    frag.append(el("div", { class: "section-title", text: "How should these be filed?" }));
    frag.append(el("button", {
      class: "btn-main btn-center",
      onclick: () => fileStaged({ separate: true, label: label.value.trim(), note: note.value.trim() })
    }, [
      document.createTextNode(`Send as ${S.staged.length} separate pieces`),
      el("span", { class: "btn-sub", text: "He decides on each one on its own" })
    ]));
    frag.append(el("button", {
      class: "btn-quiet btn-center",
      onclick: () => fileStaged({ separate: false, label: label.value.trim(), note: note.value.trim() })
    }, [
      document.createTextNode("Send as one piece with several photos"),
      el("span", { class: "btn-sub", text: "Front and back of the same envelope" })
    ]));
  } else {
    frag.append(el("button", {
      class: "btn-main btn-center",
      text: "Send it to Ayman's mailbox",
      onclick: () => fileStaged({ separate: false, label: label.value.trim(), note: note.value.trim() })
    }));
  }

  frag.append(el("div", { class: "section-title", text: "Optional" }));
  frag.append(label);
  frag.append(note);
  return frag;
}

function courierMailboxView() {
  const frag = document.createDocumentFragment();
  const waiting = S.items.filter(needsOwner);
  const working = S.items.filter(needsCourier);
  const done = S.items.filter((i) => i.status === "done").slice(0, 20);

  // This tab is the only place mail can be deleted, and only from this account.
  const withDelete = (item) => itemCard(item, el("div", { class: "choices" }, [
    el("button", { class: "btn-quiet btn-center", text: "Delete", onclick: () => deleteItem(item) })
  ]));

  frag.append(el("div", { class: "section-title", text: "Waiting on Ayman" }));
  if (!waiting.length) frag.append(el("div", { class: "empty", text: "Ayman has looked at everything." }));
  for (const item of waiting) frag.append(withDelete(item));

  if (working.length) {
    frag.append(el("div", { class: "section-title", text: "On me" }));
    for (const item of working) frag.append(withDelete(item));
  }
  if (done.length) {
    frag.append(el("div", { class: "section-title", text: "Finished" }));
    for (const item of done) frag.append(withDelete(item));
  }
  return frag;
}

// Everything about who gets emailed lives here, on the courier side only. The
// webhook url and secret are write only: they can be set from here but the
// database will not hand them back to a browser.
// Sends a test and then genuinely watches for the relay's reply, polling the
// response log rather than waiting a made up length of time. Runs in the
// background: the app stays usable and a toast reports the real answer.
async function watchRelay(fn, args, noChannelMessage) {
  try {
    // Anything already in the log belongs to an earlier attempt.
    const { data: base } = await sb.rpc("last_email_result", { p_after: 0 });
    const since = base?.id ?? 0;

    const { data, error } = await sb.rpc(fn, args);
    if (error) throw error;
    if (data === false) throw new Error(noChannelMessage);

    for (let tries = 0; tries < 20; tries++) {
      await new Promise((r) => setTimeout(r, 2000));
      const { data: probe } = await sb.rpc("last_email_result", { p_after: since });
      if (probe && probe.result !== "pending") {
        toast(probe.result === "sent" ? "Test email sent" : probe.result, probe.result !== "sent");
        return;
      }
    }
    toast("The relay never answered. Check Executions in Apps Script.", true);
  } catch (err) {
    console.error(err);
    toast(err?.message || "Could not reach the relay", true);
  }
}

const watchTestEmail = (to) =>
  watchRelay("send_test_email", { p_to: to }, "Save the Apps Script URL first");

const pingRelay = () =>
  watchRelay("ping_relay", {}, "Save the Apps Script URL first");

function notifySettings() {
  const cfg = S.notify || {};
  sheet("Email notifications", (panel, close) => {
    const check = (labelText, on) => {
      const box = el("input", { type: "checkbox" });
      box.checked = !!on;
      const row = el("label", { class: "toggle" }, [box]);
      row.append(document.createTextNode(" " + labelText));
      panel.append(row);
      return box;
    };

    const mine = el("input", { type: "email", placeholder: "you@example.com", value: cfg.courier_email || "" });
    panel.append(el("label", { class: "field", text: "Email me at" }));
    panel.append(mine);
    const meOn = check("Send me digests", cfg.courier_enabled ?? true);
    const remind = check("Remind me on mail run day", cfg.run_reminder ?? true);

    const theirs = el("input", { type: "email", placeholder: "ayman@example.com", value: cfg.owner_email || "" });
    panel.append(el("label", { class: "field", text: "Email Ayman at" }));
    panel.append(theirs);
    const themOn = check("Send Ayman digests", cfg.owner_enabled ?? false);
    panel.append(el("p", { class: "card-note", text: cfg.owner_opt_in === false
      ? "Ayman has turned these off on his side, so nothing will send to him."
      : "Ayman has these on on his side, so this switch is all that is needed." }));

    const delay = el("select");
    for (const m of [15, 30, 60, 120, 240]) {
      const label = m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`;
      const opt = el("option", { value: String(m), text: label });
      if ((cfg.digest_minutes ?? 60) === m) opt.selected = true;
      delay.append(opt);
    }
    panel.append(el("label", { class: "field", text: "Wait this long after the first change, then send one email" }));
    panel.append(delay);

    panel.append(el("label", { class: "field", text: "Apps Script web app URL" }));
    const url = el("input", { type: "text", placeholder: "https://script.google.com/macros/s/.../exec", autocapitalize: "none", spellcheck: "false" });
    panel.append(url);

    panel.append(el("label", { class: "field", text: "Shared secret (paste this into the script too)" }));
    const secret = el("input", { type: "text", placeholder: "leave blank to keep the current one", autocapitalize: "none", spellcheck: "false" });
    panel.append(secret);
    panel.append(el("button", {
      class: "btn-quiet btn-center",
      text: "Generate a secret",
      onclick: () => { secret.value = crypto.randomUUID().replace(/-/g, ""); }
    }));

    panel.append(el("button", {
      class: "btn-main btn-center",
      text: "Save",
      onclick: async () => {
        close();
        const ok = await guard("Saving", async () => {
          const cfgRes = await sb.rpc("set_notify_config", {
            p_courier_email: mine.value,
            p_owner_email: theirs.value,
            p_courier_enabled: meOn.checked,
            p_owner_enabled: themOn.checked,
            p_digest_minutes: Number(delay.value),
            p_run_reminder: remind.checked
          });
          if (cfgRes.error) throw cfgRes.error;
          if (url.value.trim() || secret.value.trim()) {
            const chRes = await sb.rpc("set_notify_channel", {
              p_url: url.value.trim() || null,
              p_secret: secret.value.trim() || null
            });
            if (chRes.error) throw chRes.error;
          }
          return true;
        });
        if (ok) { toast("Saved"); await refresh(); }
      }
    }));

    panel.append(el("button", {
      class: "btn-quiet btn-center",
      text: "Check the connection",
      onclick: () => { toast("Checking the relay"); pingRelay(); }
    }));

    panel.append(el("button", {
      class: "btn-quiet btn-center",
      text: "Send me a test email now",
      onclick: async () => {
        const to = mine.value.trim();
        if (!to) { toast("Put your email in first", true); return; }
        // Fire and watch. Google can take half a minute to answer, which is no
        // reason to hold the whole app hostage behind a spinner.
        toast("Testing. I will tell you what the relay says.");
        watchTestEmail(to);
      }
    }));
  });
}

async function logVisit() {
  const ok = await guard("Saving", async () => {
    const { error } = await sb.rpc("log_visit");
    if (error) throw error;
    return true;
  });
  if (ok) { await refresh(); toast("Next run is " + longDay(S.schedule.next_visit_date)); }
}

function editSchedule() {
  sheet("Mail run schedule", (panel, close) => {
    const date = el("input", { type: "date", value: S.schedule.next_visit_date });
    const every = el("input", { type: "text", inputmode: "numeric", value: String(S.schedule.interval_days) });
    panel.append(el("label", { class: "field", text: "Next run" }));
    panel.append(date);
    panel.append(el("label", { class: "field", text: "Repeat every how many days" }));
    panel.append(every);
    panel.append(el("button", {
      class: "btn-main btn-center",
      text: "Save",
      onclick: async () => {
        close();
        const ok = await guard("Saving", async () => {
          const { error } = await sb.rpc("set_schedule", {
            p_next: date.value, p_interval: Number(every.value) || S.schedule.interval_days
          });
          if (error) throw error;
          return true;
        });
        if (ok) { toast("Schedule updated"); await refresh(); }
      }
    }));
  });
}

function respondRequest(req, accept) {
  if (!accept) {
    sheet("Cannot make that date", (panel, close) => {
      const note = el("textarea", { placeholder: "Let Ayman know why, or when you can (optional)" });
      panel.append(note);
      panel.append(el("button", {
        class: "btn-main btn-center",
        text: "Send",
        onclick: async () => {
          close();
          const ok = await guard("Sending", async () => {
            const { error } = await sb.rpc("respond_visit_request", {
              p_request: req.id, p_accept: false, p_date: null, p_note: note.value
            });
            if (error) throw error;
            return true;
          });
          if (ok) { toast("Ayman has been told"); await refresh(); }
        }
      }));
    });
    return;
  }
  sheet("Confirm the earlier run", (panel, close) => {
    const date = el("input", { type: "date", value: req.requested_date });
    panel.append(el("label", { class: "field", text: "Day you will go" }));
    panel.append(date);
    panel.append(el("button", {
      class: "btn-main btn-center",
      text: "Confirm",
      onclick: async () => {
        close();
        const ok = await guard("Saving", async () => {
          const { error } = await sb.rpc("respond_visit_request", {
            p_request: req.id, p_accept: true, p_date: date.value, p_note: null
          });
          if (error) throw error;
          return true;
        });
        if (ok) { toast("Locked in"); await refresh(); }
      }
    }));
  });
}

/* ------------------------------------------------------------------ shell */

function tabsFor() {
  return isCourier()
    ? [
        { id: "todo", label: "To do", glyph: "✓", badge: S.items.filter(needsCourier).length },
        { id: "add", label: "Add mail", glyph: "＋", badge: S.staged.length },
        { id: "mailbox", label: "Mailbox", glyph: "✉️", badge: 0 },
        { id: "watch", label: "Watching", glyph: "👁", badge: 0 }
      ]
    : [
        { id: "mail", label: "Mail", glyph: "✉️", badge: S.items.filter(needsOwner).length },
        { id: "watch", label: "Watching", glyph: "👁", badge: 0 }
      ];
}

function render() {
  if (!S.profile) return;
  const tabs = tabsFor();
  if (!tabs.some((t) => t.id === S.tab)) S.tab = tabs[0].id;

  renderTopbar();

  clear($tabs);
  for (const t of tabs) {
    const btn = el("button", { class: t.id === S.tab ? "on" : "", onclick: () => { S.tab = t.id; render(); window.scrollTo(0, 0); } });
    btn.append(el("span", { class: "glyph", text: t.glyph }));
    btn.append(document.createTextNode(t.label));
    if (t.badge > 0) btn.append(el("span", { class: "dot", text: String(t.badge) }));
    $tabs.append(btn);
  }

  clear($view);
  const body =
    S.tab === "watch" ? watchView() :
    S.tab === "mail" ? ownerMailView() :
    S.tab === "todo" ? courierTodoView() :
    S.tab === "add" ? courierAddView() :
    courierMailboxView();
  $view.append(body);
}

/* ------------------------------------------------------------------ auth */

// Supabase Auth keys on an email address, but nobody here wants to type one.
// A plain username gets a fixed domain stuck on the back of it. Anything that
// already looks like an address is passed through untouched, so a real email
// still works if one is ever needed.
const LOGIN_DOMAIN = "mailbox.local";
const asEmail = (name) => {
  const v = name.trim().toLowerCase();
  return v.includes("@") ? v : `${v}@${LOGIN_DOMAIN}`;
};

// Signing in normally sticks on its own: the session is stored and refreshed, so
// the password is typed once. iOS can still evict that storage after a stretch
// of not opening the app, which for a weekly errand lands right on the boundary.
// So the username is always remembered, and "stay signed in" additionally keeps
// the password on this device and signs in on launch without asking.
const SAVED_USER = "mailbox.username";
const SAVED_LOGIN = "mailbox.login";

const readSaved = () => {
  try { return JSON.parse(localStorage.getItem(SAVED_LOGIN) || "null"); } catch { return null; }
};

const forgetLogin = () => {
  localStorage.removeItem(SAVED_LOGIN);
  localStorage.removeItem(SAVED_USER);
};

function renderSignIn(message) {
  $boot.hidden = true;
  $app.hidden = true;
  document.getElementById("tabs").hidden = true;

  let form = document.querySelector(".signin");
  if (form) form.remove();
  form = el("form", { class: "signin" });
  const user = el("input", {
    type: "text", placeholder: "Username", autocomplete: "username",
    autocapitalize: "none", autocorrect: "off", spellcheck: "false", required: true
  });
  const pass = el("input", { type: "password", placeholder: "Password", autocomplete: "current-password", required: true, name: "password" });
  user.setAttribute("name", "username");
  user.value = localStorage.getItem(SAVED_USER) || "";

  const stay = el("input", { type: "checkbox" });
  stay.checked = !!readSaved() || !localStorage.getItem(SAVED_USER);
  const stayRow = el("label", { class: "stay" }, [stay]);
  stayRow.append(document.createTextNode(" Stay signed in on this phone"));

  form.append(el("h1", { text: "Mailbox" }));
  form.append(el("p", { text: message || "Sign in to see the mail." }));
  form.append(user);
  form.append(pass);
  form.append(stayRow);
  form.append(el("button", { class: "btn-main btn-center", type: "submit", text: "Sign in" }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = user.value.trim();
    const ok = await guard("Signing in", async () => {
      const { error } = await sb.auth.signInWithPassword({ email: asEmail(name), password: pass.value });
      if (error) throw new Error(/invalid/i.test(error.message) ? "Wrong username or password" : error.message);
      return true;
    });
    if (ok) {
      localStorage.setItem(SAVED_USER, name);
      if (stay.checked) localStorage.setItem(SAVED_LOGIN, JSON.stringify({ u: name, p: pass.value }));
      else localStorage.removeItem(SAVED_LOGIN);
      form.remove();
      await start();
    }
  });
  document.body.append(form);
  if (user.value) pass.focus();
}

async function start() {
  let { data: { session } } = await sb.auth.getSession();

  // Storage got cleared but the phone is a trusted one: sign back in quietly
  // rather than making him find the password again.
  if (!session) {
    const saved = readSaved();
    if (saved?.u && saved?.p) {
      busy("Signing in");
      const { data, error } = await sb.auth.signInWithPassword({ email: asEmail(saved.u), password: saved.p });
      busy(false);
      if (error) {
        forgetLogin();
        renderSignIn("Your saved password no longer works. Please sign in again.");
        return;
      }
      session = data?.session ?? (await sb.auth.getSession()).data.session;
    }
  }

  S.session = session;
  if (!session) { renderSignIn(); return; }

  const { data: profile, error } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (error) { renderSignIn("Could not reach the database. Check your connection."); return; }
  if (!profile) {
    await sb.auth.signOut();
    renderSignIn("That login is not linked to a role yet. Run create_users.sql first.");
    return;
  }

  S.profile = profile;
  document.querySelector(".signin")?.remove();
  $boot.hidden = true;
  $app.hidden = false;
  document.getElementById("tabs").hidden = false;

  await refresh(false);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && S.profile) refresh();
});
setInterval(() => { if (!document.hidden && S.profile) refresh(); }, 45000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

start();
