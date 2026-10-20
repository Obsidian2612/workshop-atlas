import { defineHandler } from "nitro";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, fail, filename, logActivity, requireUser, text, transact } from "../../utils/store";
const limit = 10 * 1024 * 1024;
export default defineHandler(async event => {
  await transact(db => requireUser(db, event.req, "write"));
  const reader = event.req.body?.getReader();
  if (!reader) fail(400, "A file is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit + 65536) { await reader.cancel(); fail(413, "Files must be 10 MB or smaller"); }
    chunks.push(chunk.value);
  }
  const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": event.req.headers.get("content-type") || "" } }).formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) fail(400, "Choose a non-empty file");
  if (file.size > limit) fail(413, "Files must be 10 MB or smaller");
  const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain"];
  if (!allowed.includes(file.type)) fail(400, "Upload JPG, PNG, WebP, PDF or plain-text files");
  const recordId = text(form.get("recordId"), "Linked record", 80, true);
  const id = randomUUID();
  const destination = path.join(dataDir, "attachments", `${id}.bin`);
  try {
    return await transact(async db => {
      const user = requireUser(db, event.req, "write");
      if (!db.records.some(r => r.id === recordId) && !db.vehicles.some(v => v.id === recordId)) fail(400, "Select an existing vehicle or record");
      const attachment = { id, recordId, name: filename(file.name), type: file.type, size: file.size, createdAt: new Date().toISOString(), createdBy: user.name };
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
      db.attachments.unshift(attachment);
      logActivity(db, user, `Uploaded ${attachment.name}`);
      return attachment;
    }, true);
  } catch (error) { await fs.rm(destination, { force: true }); throw error; }
});
