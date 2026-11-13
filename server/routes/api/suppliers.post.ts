import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { randomUUID } from "node:crypto";
import { fail, logActivity, requireUser, text, transact } from "../../utils/store";

// Suppliers are links, never embedded content: only an http(s) address is kept,
// so every entry can be opened from the parts list without surprises.
function webAddress(value: unknown, label: string, required: boolean) {
  const raw = text(value, label, 1000, required);
  if (!raw) return "";
  let url: URL;
  try { url = new URL(raw); } catch { fail(400, `Enter a full http:// or https:// address for the ${label.toLowerCase()}`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) fail(400, `Use an HTTP or HTTPS address for the ${label.toLowerCase()}, without embedded credentials`);
  return url.toString();
}

export default defineHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object") fail(400, "Invalid request");
  const action = text(body.action, "Action", 20, true);
  if (!["save", "delete"].includes(action)) fail(400, "Unknown operation");
  return transact(db => {
    const user = requireUser(db, event.req, "write");
    const id = text(body.id, "ID", 80);
    if (action === "delete") {
      const supplier = db.suppliers.find(item => item.id === id);
      if (!supplier) fail(404, "Supplier not found");
      db.suppliers = db.suppliers.filter(item => item.id !== id);
      // Parts that pointed at it keep their number and make; the link is simply gone.
      db.records = db.records.map(record => record.supplierId === id ? { ...record, supplierId: "" } : record);
      logActivity(db, user, `Removed supplier ${supplier.name}`);
      return { ok: true };
    }
    const existing = id ? db.suppliers.find(item => item.id === id) : undefined;
    if (id && !existing) fail(404, "Supplier not found");
    const name = text(body.name, "Supplier name", 100, true);
    if (db.suppliers.some(item => item.name.toLowerCase() === name.toLowerCase() && item.id !== existing?.id)) fail(400, "A supplier with that name is already listed");
    const now = new Date().toISOString();
    // The optional search address is checked with the placeholder filled in, so a
    // template that cannot produce a working link is refused now rather than later.
    const searchUrl = text(body.searchUrl, "Search address", 1000);
    if (searchUrl) webAddress(searchUrl.split("{query}").join("brake pads"), "Search address", false);
    const supplier = {
      id: existing?.id || randomUUID(), name,
      website: webAddress(body.website, "Website", true), searchUrl,
      createdAt: existing?.createdAt || now, createdBy: existing?.createdBy || user.name,
    };
    db.suppliers = [supplier, ...db.suppliers.filter(item => item.id !== supplier.id)];
    logActivity(db, user, `${existing ? "Updated" : "Added"} supplier ${supplier.name}`);
    return supplier;
  }, true);
});
