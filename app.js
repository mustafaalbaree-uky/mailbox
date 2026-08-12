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
  watch: [],
  schedule: null,
  requests: [],
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
  forward:    { owner: "Send it to me",              courier: "Mail it to him",            glyph: "✈️" },
  hold:       { owner: "Hold on to it",              courier: "Put it in his box",         glyph: "📦" },
  discard:    { owner: "Throw it away",              courier: "Throw it away",             glyph: "🗑️" },
  open_photo: { owner: "Open it, send me a photo",   courier: "Open it and photograph it", glyph: "📷" },
  open_scan:  { owner: "Open it, send me a scan",    courier: "Open it and scan it",       glyph: "🖨️" }
};
const DISPOSITION = { forwarded: "Mailed to him", held: "Held here", discarded: "Thrown away" };

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
  const [items, watch, schedule, requests] = await Promise.all([
    sb.from("mail_items").select("*").order("created_at", { ascending: false }).limit(200),
    sb.from("watch_items").select("*").order("created_at", { ascending: false }),
    sb.from("schedule").select("*").eq("id", 1).single(),
    sb.from("visit_requests").select("*").order("created_at", { ascending: false }).limit(10)
  ]);
  for (const r of [items, watch, schedule, requests]) if (r.error) throw r.error;

  S.items = items.data;
  S.watch = watch.data;
  S.schedule = schedule.data;
  S.requests = requests.data;

  const ids = S.items.map((i) => i.id);
  S.photos = new Map();
  if (ids.length) {
    const { data, error } = await sb.from("item_photos").select("*").in("item_id", ids).order("created_at");
    if (error) throw error;
    for (const p of data) {
      if (!S.photos.has(p.item_id)) S.photos.set(p.item_id, []);
      S.photos.get(p.item_id).push(p);
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
  const label = item.status === "action_needed"
    ? "Mustafa is on it"
    : "Waiting on him";
  return el("span", { class: "pill wait", text: label });
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
  body.append(statusPill(item));
  if (item.label) body.append(el("div", { class: "card-label", text: item.label }));
  if (item.courier_note) body.append(el("div", { class: "card-note", text: item.courier_note }));
  if (item.decision_note) body.append(el("div", { class: "card-note", text: "“" + item.decision_note + "”" }));
  body.append(el("div", { class: "card-meta", text: "Picked up " + shortWhen(item.created_at) }));
  card.append(body);

  if (actions) card.append(actions);
  return card;
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

async function uploadBlobs(blobs, onProgress) {
  const stamp = isoDay(new Date()).slice(0, 7);
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
  if (ok) { toast("Sent to him for a look"); await refresh(); }
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
    toast(count === 1 ? "Added to his mailbox" : `${count} items added`);
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
      onclick: async () => { await sb.auth.signOut(); location.reload(); }
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
  } else {
    frag.append(el("button", {
      class: "btn-quiet btn-center",
      text: "Ask for an earlier mail run",
      onclick: askSooner
    }));
  }

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
                  : "He is not waiting on anything in particular."
    }));
  }
  for (const w of live) {
    const card = el("div", { class: "card" });
    const body = el("div", { class: "card-body" });
    body.append(el("div", { class: "card-label", text: w.description }));
    if (w.details) body.append(el("div", { class: "card-note", text: w.details }));
    body.append(el("div", { class: "card-meta", text: "Added " + shortWhen(w.created_at) }));
    card.append(body);
    card.append(el("div", { class: "choices two" }, [
      el("button", { class: "btn-quiet btn-center", text: "It came in", onclick: () => resolveWatch(w, "found") }),
      el("button", { class: "btn-quiet btn-center", text: "Never mind", onclick: () => resolveWatch(w, "cancelled") })
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
        ])
      ]));
    }
  }
  return frag;
}

function addWatch() {
  sheet("Watch for something", (panel, close) => {
    const what = el("input", { type: "text", placeholder: "e.g. new debit card from Chase" });
    const more = el("textarea", { placeholder: "Anything that helps him spot it (optional)" });
    panel.append(el("label", { class: "field", text: "What are you expecting?" }));
    panel.append(what);
    panel.append(more);
    panel.append(el("button", {
      class: "btn-main btn-center",
      text: "Add it",
      onclick: async () => {
        if (!what.value.trim()) { toast("Give it a short name first", true); return; }
        close();
        const ok = await guard("Saving", async () => {
          const { error } = await sb.from("watch_items").insert({
            description: what.value.trim(),
            details: more.value.trim() || null,
            created_by: S.session.user.id
          });
          if (error) throw error;
          return true;
        });
        if (ok) { toast("Added"); await refresh(); }
      }
    }));
  });
}

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
      el("strong", { text: "He is asking for an earlier run" }),
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

  const todo = S.items.filter(needsCourier);
  frag.append(el("div", { class: "section-title", text: todo.length ? "To do" : "Nothing to do" }));
  if (!todo.length) frag.append(el("div", { class: "empty", text: "No requests from him right now." }));

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
  const note = el("textarea", { placeholder: "Optional note for him" });
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
      text: "Send it to his mailbox",
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

  frag.append(el("div", { class: "section-title", text: "Waiting on him" }));
  if (!waiting.length) frag.append(el("div", { class: "empty", text: "He has looked at everything." }));
  for (const item of waiting) frag.append(itemCard(item, null));

  if (working.length) {
    frag.append(el("div", { class: "section-title", text: "On me" }));
    for (const item of working) frag.append(itemCard(item, null));
  }
  if (done.length) {
    frag.append(el("div", { class: "section-title", text: "Finished" }));
    for (const item of done) frag.append(itemCard(item, null));
  }
  return frag;
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
      const note = el("textarea", { placeholder: "Let him know why, or when you can (optional)" });
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
          if (ok) { toast("He has been told"); await refresh(); }
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
        { id: "mailbox", label: "Mailbox", glyph: "✉", badge: 0 },
        { id: "watch", label: "Watching", glyph: "👁", badge: 0 }
      ]
    : [
        { id: "mail", label: "Mail", glyph: "✉", badge: S.items.filter(needsOwner).length },
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

function renderSignIn(message) {
  $boot.hidden = true;
  $app.hidden = true;
  document.getElementById("tabs").hidden = true;

  let form = document.querySelector(".signin");
  if (form) form.remove();
  form = el("form", { class: "signin" });
  const email = el("input", { type: "email", placeholder: "Email", autocomplete: "username", required: true });
  const pass = el("input", { type: "password", placeholder: "Password", autocomplete: "current-password", required: true });
  form.append(el("h1", { text: "Mailbox" }));
  form.append(el("p", { text: message || "Sign in to see the mail." }));
  form.append(email);
  form.append(pass);
  form.append(el("button", { class: "btn-main btn-center", type: "submit", text: "Sign in" }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ok = await guard("Signing in", async () => {
      const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
      if (error) throw error;
      return true;
    });
    if (ok) { form.remove(); await start(); }
  });
  document.body.append(form);
}

async function start() {
  const { data: { session } } = await sb.auth.getSession();
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
