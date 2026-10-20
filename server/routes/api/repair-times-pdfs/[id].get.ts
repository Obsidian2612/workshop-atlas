import { defineHandler } from "nitro";
import { getRouterParam } from "nitro/h3";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir, fail, requireUser, transact } from "../../../utils/store";

export default defineHandler(async event => {
  const id = getRouterParam(event, "id");
  if (!id) fail(400, "Invalid PDF ID");
  const sheet = await transact(db => {
    requireUser(db, event.req, "read");
    return (db.repairTimePdfs || []).find(pdf => pdf.id === id);
  });
  if (!sheet) fail(404, "Repair-time PDF not found");
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path.join(dataDir, "repair-times-pdfs", `${sheet.id}.pdf`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(404, "Repair-time PDF not found");
    throw error;
  }
  return new Response(bytes, { headers: {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(sheet.name)}`,
    "Content-Length": String(bytes.length),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  } });
});
