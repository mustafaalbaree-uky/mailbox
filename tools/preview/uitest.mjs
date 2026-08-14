// Drives the To do tab in jsdom against the fake Supabase: taps a filter chip,
// stages several photos of one envelope, sends them, and checks that the
// background poll leaves the page alone when nothing has changed.
//
//   node tools/preview/build.mjs && node tools/preview/uitest.mjs
//
// Loads the real app.js (with supabase faked) into jsdom, then clicks around
// the To do tab the way a thumb would.
import { JSDOM } from "jsdom";  // npm i jsdom (not a dependency of the app itself)
import fs from "fs";

const dir = new URL("./build/", import.meta.url);
const html = fs.readFileSync(new URL("index.html", dir), "utf8");

const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.location = window.location;
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Image = window.Image;
globalThis.URL.createObjectURL = () => "blob:fake";
globalThis.URL.revokeObjectURL = () => {};
window.MAILBOX_CONFIG = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "k" };
window.scrollTo = () => {};
globalThis.scrollTo = () => {};


// The picker and the compressor are the two places a real camera would be.
window.__pick = ({ pdf }) => [pdf && window.__wantPdf ? { name: "Statement.pdf", type: "application/pdf" } : { name: "shot.jpg", type: "image/jpeg" }];
window.__rpc = [];
const app = await import(new URL("app.js", dir));

const settle = () => new Promise((r) => setTimeout(r, 60));
await settle();
await settle();

const view = () => window.document.getElementById("view");
const buttons = () => [...view().querySelectorAll("button")].map((b) => b.textContent.trim());
const chips = () => [...view().querySelectorAll(".chip")].map((c) => c.textContent.trim());
const cards = () => [...view().querySelectorAll(".card")].map((c) => {
  const seq = c.querySelector(".card-seq")?.textContent || "";
  const pill = c.querySelector(".pill")?.textContent || "";
  return `${seq} ${pill}`.trim();
});
const tapStarts = (prefix) => {
  const b = [...view().querySelectorAll("button")].find((x) => x.textContent.trim().startsWith(prefix));
  if (!b) throw new Error(`no button starting "${prefix}" among: ${buttons().join(" | ")}`);
  b.click();
};
const tap = (text) => {
  const b = [...view().querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (!b) throw new Error(`no button "${text}" among: ${buttons().join(" | ")}`);
  b.click();
};

const tabs = [...window.document.getElementById("tabs").querySelectorAll("button")];
console.log("tabs:", tabs.map((t) => t.textContent.trim()).join(" | "));
tabs.find((t) => t.textContent.includes("To do")).click();
await settle();

console.log("\n-- To do, unfiltered");
console.log("chips:", chips().join("   "));
console.log("cards:", cards().join(", "));

console.log("\n-- after tapping the Hold chip");
tapStarts("📦 Hold");
await settle();
console.log("chips:", chips().join("   "));
console.log("cards:", cards().join(", "));

console.log("\n-- back to All");
tapStarts("All");
await settle();
console.log("cards:", cards().join(", "));

console.log("\n-- opening #10, staging three photos");
tapStarts("📷 Photograph");
await settle();
tap("Photograph the contents");
await settle();
console.log("after first pick:", buttons().filter((b) => /photo|Send|Cancel/i.test(b)).join(" | "));
tap("Take another photo");
await settle();
tap("Take another photo");
await settle();
console.log("after three:", buttons().filter((b) => /photo|Send|Cancel/i.test(b)).join(" | "));
console.log("thumbnails:", view().querySelectorAll(".staged img").length);

console.log("\n-- sending");
tap("Send all 3 to Ayman");
await settle();
await settle();
console.log("rpc calls:", window.__rpc.join(" ; "));

console.log("\n-- the background poll, with nothing changed");
const { DB } = await import(new URL("fake-supabase.js", dir));
const before = view().querySelector(".card");
const beforeHtml = view().innerHTML;
window.document.dispatchEvent(new window.Event("visibilitychange"));
await settle(); await settle();
console.log("same card element kept:", view().querySelector(".card") === before);
console.log("view untouched:", view().innerHTML === beforeHtml);

console.log("\n-- the background poll, after Ayman decides something");
DB.mail_items.find((i) => i.seq === 3).status = "action_needed";
DB.mail_items.find((i) => i.seq === 3).decision = "forward";
window.document.dispatchEvent(new window.Event("visibilitychange"));
await settle(); await settle();
console.log("redrew:", view().querySelector(".card") !== before);
console.log("cards:", cards().join(", "));
console.log("\n-- a scan attached as a pdf");
window.__rpc.length = 0;
window.__wantPdf = true;
tapStarts("🖨️ Scan");
await settle();
tap("Attach the scan");
await settle();
console.log("staged tile:", view().querySelector(".doc-tile")?.textContent.trim(), "| thumbnails:", view().querySelectorAll(".staged img").length);
console.log("buttons:", buttons().filter((b) => /Send|another|Choose/.test(b)).join(" | "));
tap("Send it to Ayman");
await settle(); await settle();
console.log("rpc:", window.__rpc.join(" ; "));
window.__wantPdf = false;

console.log("\n-- the junk escape on an item he asked to be opened");
tapStarts("All");
await settle();
const openCard = [...view().querySelectorAll(".card")].find((c) => c.textContent.includes("Open it and photograph it"));
console.log("buttons on it:", [...openCard.querySelectorAll("button")].map((b) => b.textContent.trim()).join(" | "));
[...openCard.querySelectorAll("button")].find((b) => b.textContent.includes("Junk")).click();
await settle();
const sheetEl = window.document.getElementById("sheet");
console.log("sheet:", sheetEl.querySelector("h2").textContent);
sheetEl.querySelector("input").value = "an advert";
[...sheetEl.querySelectorAll("button")].find((b) => b.textContent.trim() === "Throw it away").click();
await settle(); await settle();
console.log("rpc:", window.__rpc.slice(-1)[0]);

console.log("\n-- a pdf scan on the Mailbox tab, and taking a send back");
window.__rpc.length = 0;
[...window.document.getElementById("tabs").querySelectorAll("button")].find((t) => t.textContent.includes("Mailbox")).click();
await settle(); await settle();
const pdfCard = [...view().querySelectorAll(".card")].find((c) => c.querySelector(".docs"));
console.log("doc row:", pdfCard.querySelector(".doc-name").textContent,
  "| links:", [...pdfCard.querySelectorAll(".doc-btn")].map((a) => a.textContent + "=" + (a.href || "").slice(0, 60)).join(" , "));
console.log("images rendered for the pdf:", pdfCard.querySelectorAll(".docs img").length);
const readBtn = [...pdfCard.querySelectorAll(".doc-btn")].find((b) => b.textContent.trim() === "Read");
console.log("Read is a real button:", readBtn.tagName);
readBtn.click();
await settle(); await settle();
const lb = window.document.getElementById("lightbox");
console.log("viewer opened:", !lb.hidden, "| pane:", !!lb.querySelector(".zoomer.pdf"), "| says:", lb.querySelector(".pdf-status")?.textContent);
lb.querySelector(".close").click();
[...pdfCard.querySelectorAll("button")].find((b) => b.textContent.includes("Take it back")).click();
await settle();
[...window.document.getElementById("sheet").querySelectorAll("button")].find((b) => b.textContent.trim() === "Take it back").click();
await settle(); await settle();
console.log("rpc:", window.__rpc.join(" ; "));

process.exit(0);
