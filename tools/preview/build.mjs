// Builds a runnable copy of the app with Supabase faked, into tools/preview/build,
// so the interface can be driven without a login and without touching real mail.
//
//   node tools/preview/build.mjs        # then: cd tools/preview/build && python3 -m http.server 8000
//
// Two edits are made to app.js on the way through: the supabase import points at
// the fake, and the file picker and the photo resizer get a test door so a script
// can stand in for the camera. Nothing else changes, so what runs here is the
// real interface code.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = path.join(here, "build");

fs.mkdirSync(out, { recursive: true });

let app = fs.readFileSync(path.join(root, "app.js"), "utf8");
app = app.replace(
  'import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";',
  'import { createClient } from "./fake-supabase.js";'
);

const door = (anchor, line) => {
  if (!app.includes(anchor)) throw new Error("anchor moved, fix build.mjs: " + anchor);
  app = app.replace(anchor, anchor + "\n  " + line);
};

door("function pickFiles({ camera }) {", "if (window.__pick) return Promise.resolve(window.__pick(camera));");
door("function compress(file, max = 1800, quality = 0.82) {", "if (window.__pick) return Promise.resolve(file);");

fs.writeFileSync(path.join(out, "app.js"), app);
for (const f of ["app.css", "config.js", "index.html"]) {
  fs.copyFileSync(path.join(root, f), path.join(out, f));
}
fs.copyFileSync(path.join(here, "fake-supabase.js"), path.join(out, "fake-supabase.js"));

console.log("preview built in " + path.relative(root, out));
