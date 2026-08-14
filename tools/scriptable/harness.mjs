// Runs the widget against canned Supabase responses with a stub of the parts of
// Scriptable it touches, so the whole path is exercised off the phone.
//
//   node tools/scriptable/harness.mjs tools/scriptable/mailbox-widget.js
//   FAMILY=large ROLE=owner node tools/scriptable/harness.mjs tools/scriptable/mailbox-widget.js
//
// It prints the widget as an indented tree of the text it would draw. Fonts and
// colours are stubs, so this checks what the widget says and which rows survive
// the size cap, not how it looks.
import fs from "fs";

const src = fs.readFileSync(process.argv[2], "utf8");

const day = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const ROUTES = [
  // The fragment that JSONSerialization refuses and JSON.parse accepts.
  [/rpc\/my_role/, 200, JSON.stringify(process.env.ROLE || "courier")],
  [/schedule\?/, 200, JSON.stringify([{ next_visit_date: day(3), interval_days: 7 }])],
  [/mail_items\?/, 200, JSON.stringify([
    { seq: 12, label: "Chase", status: "action_needed", decision: "open_scan", decision_note: "front page only", updated_at: "2026-08-13T10:00:00Z" },
    { seq: 11, label: null, status: "action_needed", decision: "hold", decision_note: null, updated_at: "2026-08-13T09:00:00Z" },
    { seq: 9, label: "DMV", status: "action_needed", decision: "forward", decision_note: null, updated_at: "2026-08-12T09:00:00Z" },
    { seq: 8, label: "junk", status: "action_needed", decision: "discard", decision_note: null, updated_at: "2026-08-12T08:00:00Z" },
    { seq: 7, label: "Aetna", status: "action_needed", decision: "open_photo", decision_note: null, updated_at: "2026-08-11T08:00:00Z" },
    { seq: 3, label: "waiting on him", status: "awaiting_decision", decision: null, decision_note: null, updated_at: "2026-08-10T08:00:00Z" }
  ])],
  [/visit_requests\?/, 200, JSON.stringify([{ requested_date: day(1), reason: "passport" }])],
  [/watch_items\?/, 200, JSON.stringify([{ id: "a" }, { id: "b" }])]
];

globalThis.Request = class {
  constructor(url) { this.url = url; this.headers = {}; this.method = "GET"; }
  async loadString() {
    const hit = ROUTES.find(([re]) => re.test(this.url));
    if (!hit) throw new Error("harness has no route for " + this.url);
    this.response = { statusCode: hit[1] };
    return hit[2];
  }
};

globalThis.Keychain = {
  store: {
    "mailbox.widget.session": JSON.stringify({
      access_token: "t", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600
    })
  },
  contains(k) { return k in this.store; },
  get(k) { return this.store[k]; },
  set(k, v) { this.store[k] = v; }
};

globalThis.FileManager = { local: () => ({
  joinPath: (a, b) => a + "/" + b,
  documentsDirectory: () => "/tmp",
  fileExists: () => false,
  readString: () => "",
  writeString: (p, s) => { globalThis.__cached = s; }
}) };

globalThis.Color = class { constructor(h) { this.h = h; } static dynamic(a, b) { return new Color(a.h + "/" + b.h); } };
globalThis.Font = new Proxy({}, { get: () => (n) => ({ n }) });
globalThis.Size = class { constructor(w, h) { this.w = w; this.h = h; } };

const dump = [];
const mkStack = (depth) => ({
  depth, spacing: 0, size: null, backgroundColor: null,
  addStack() { dump.push("  ".repeat(depth) + "[stack]"); return mkStack(depth + 1); },
  addText(t) {
    dump.push("  ".repeat(depth) + JSON.stringify(t));
    return { rightAlignText() {}, leftAlignText() {}, centerAlignText() {} };
  },
  addSpacer() {},
  centerAlignContent() {}, layoutVertically() {}
});

globalThis.ListWidget = class {
  constructor() { Object.assign(this, mkStack(0)); }
  setPadding() {}
  presentMedium() { dump.push("(presented medium)"); }
  presentLarge() { dump.push("(presented large)"); }
  presentSmall() { dump.push("(presented small)"); }
};
globalThis.Script = { setWidget: () => {}, complete: () => {} };
globalThis.config = { widgetFamily: process.env.FAMILY || "medium", runsInWidget: false };

await import("data:text/javascript," + encodeURIComponent(src));
console.log(dump.join("\n"));
console.log("\ncached:", (globalThis.__cached || "").slice(0, 120) + "...");
