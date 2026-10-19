import { defineHandler } from "nitro";
import { getRouterParam } from "nitro/h3";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir, fail, requireUser, transact } from "../../../utils/store";
export default defineHandler(async event => {
  const id = getRouterParam(event, "id");
  const file = await transact(db => {
    requireUser(db, event.req);
    const attachment = db.attachments.find(a => a.id === id);
    if (!attachment) fail(404, "Attachment not found");
    return attachment;
  });
  const bytes = await fs.readFile(path.join(dataDir, "attachments", `${file.id}.bin`));
  return new Response(bytes, { headers: {
    "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  } });
});
