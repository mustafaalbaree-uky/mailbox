// Stand in for supabase-js so the app can be driven in a browser without a
// login. Enough of the query builder to satisfy app.js, and canned rows.

const ME = "u-mustafa";
const AYMAN = "u-ayman";
const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const swatch = (hue) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="hsl(${hue},45%,72%)"/><text x="200" y="160" font-size="34" text-anchor="middle" font-family="sans-serif">envelope</text></svg>`
  );

const item = (seq, label, decision, note) => ({
  id: "i-" + seq, seq, label, status: "action_needed", decision,
  decision_note: note || null, courier_note: null, created_by: ME,
  created_at: iso(seq % 7), updated_at: iso(1), final_disposition: null, decided_at: iso(1), completed_at: null
});

export const DB = {
  mail_items: [
    item(12, "Chase", "open_scan", "just the first page"),
    item(11, null, "hold"),
    item(10, "Aetna", "open_photo"),
    item(9, "DMV", "forward"),
    item(8, "coupons", "discard"),
    item(7, "Verizon", "hold"),
    item(6, "Costco", "discard"),
    { ...item(3, "Water bill", null), status: "awaiting_decision", decision: null },
    // Already sent over: a scan that went as a pdf, waiting on his review.
    { ...item(5, "Blue Cross", null), status: "awaiting_review", decision: null }
  ],
  item_photos: [
    { id: "p1", item_id: "i-12", path: "a.jpg", kind: "envelope", created_at: iso(2), created_by: ME },
    { id: "p2", item_id: "i-11", path: "b.jpg", kind: "envelope", created_at: iso(2), created_by: ME },
    { id: "p3", item_id: "i-10", path: "c.jpg", kind: "envelope", created_at: iso(2), created_by: ME },
    { id: "p4", item_id: "i-9", path: "d.jpg", kind: "envelope", created_at: iso(2), created_by: ME },
    { id: "p5", item_id: "i-5", path: "e.jpg", kind: "envelope", created_at: iso(3), created_by: ME },
    { id: "p6", item_id: "i-5", path: "2026-08/scan.pdf", kind: "contents", created_at: iso(1), created_by: ME }
  ],
  item_notes: [{ id: "n1", item_id: "i-12", author: AYMAN, body: "front page only please", created_at: iso(1) }],
  watch_items: [{ id: "w1", description: "New debit card", details: null, status: "watching", created_at: iso(4), created_by: AYMAN }],
  schedule: [{ id: 1, next_visit_date: day(3), interval_days: 7, updated_at: iso(1), updated_by: ME }],
  visit_requests: [{ id: "r1", requested_date: day(1), reason: "passport", status: "pending", created_at: iso(1), created_by: AYMAN }],
  profiles: [
    { id: ME, role: "courier", display_name: "Mustafa" },
    { id: AYMAN, role: "owner", display_name: "Ayman" }
  ],
  notify_config: [{ id: 1, enabled: false, owner_enabled: false, owner_opt_in: true, quiet_minutes: 60, courier_email: null, owner_email: null }]
};

// A builder that collects filters, applies the easy ones, and resolves to rows.
function query(table) {
  let rows = (DB[table] || []).slice();
  const b = {
    select: () => b,
    order: () => b,
    limit: () => b,
    eq: (col, v) => { rows = rows.filter((r) => r[col] === v); return b; },
    in: (col, vs) => { rows = rows.filter((r) => vs.includes(r[col])); return b; },
    insert: (row) => {
      (DB[table] ||= []).push({ id: "new-" + Math.random().toString(16).slice(2), created_at: new Date().toISOString(), ...row });
      window.__rpc?.push("insert into " + table + " " + JSON.stringify(row));
      return Promise.resolve({ data: null, error: null });
    },
    single: () => Promise.resolve({ data: rows[0] || null, error: null }),
    maybeSingle: () => Promise.resolve({ data: rows[0] || null, error: null }),
    then: (res) => res({ data: rows, error: null })
  };
  return b;
}

export function createClient() {
  const session = { user: { id: ME, email: "mustafa@mailbox.local" } };
  return {
    from: (t) => query(t),
    rpc: async (fn, args) => { (window.__rpc ||= []).push(fn + " " + JSON.stringify(args)); return { data: null, error: null }; },
    auth: {
      getSession: async () => ({ data: { session } }),
      signOut: async () => ({}),
      signInWithPassword: async () => ({ data: { session } })
    },
    storage: {
      from: () => ({
        createSignedUrls: async (paths) => ({
          data: paths.map((p, i) => ({ path: p, signedUrl: swatch(i * 70 + 20) })),
          error: null
        }),
        upload: async () => ({ error: null }),
        remove: async () => ({ error: null })
      })
    }
  };
}
