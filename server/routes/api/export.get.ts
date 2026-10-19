import { defineHandler } from "nitro";
import { requireUser, transact } from "../../utils/store";
export default defineHandler(event => transact(db => {
  requireUser(db, event.req, "write");
  return new Response(JSON.stringify({ format: "workshop-atlas-v1", exportedAt: new Date().toISOString(), name: db.name,
    vehicles: db.vehicles, records: db.records, attachments: db.attachments }, null, 2), {
    headers: { "Content-Type": "application/json", "Content-Disposition": "attachment; filename=workshop-atlas-records.json", "Cache-Control": "no-store" },
  });
}));
