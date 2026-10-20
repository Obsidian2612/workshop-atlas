import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { dataDir, fail, filename, logActivity, requireUser, transact, text } from "../../utils/store";
import { importRepairTimes, parseRepairTimeImport, refreshVehicleRepairTimes } from "../../utils/repair-times";

const pdfLimit = 10 * 1024 * 1024;
export default defineHandler(async event => {
  // The upload action sends multipart/form-data, so only JSON requests are parsed here.
  const contentType = event.req.headers.get("content-type") || "";
  let body: Record<string, unknown> = {};
  if (contentType.includes("application/json")) {
    const parsed = await readBody<Record<string, unknown>>(event);
    if (!parsed || typeof parsed !== "object") fail(400, "Invalid request");
    body = parsed;
  }
  const action = typeof body.action === "string" ? body.action : contentType.includes("multipart/form-data") ? "upload" : "";

  if (action === "import") {
    await transact(db => { requireUser(db, event.req, "admin"); return null; });
    return importRepairTimes(parseRepairTimeImport(body.format, body.data));
  }

  if (action === "refresh") {
    const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId.trim() : "";
    if (!vehicleId) fail(400, "Choose a vehicle to refresh");
    await transact(db => { requireUser(db, event.req, "write"); return null; });
    const vehicle = await refreshVehicleRepairTimes(vehicleId, true);
    if (!vehicle) fail(404, "That vehicle has no VIN, so repair times cannot be looked up");
    return vehicle;
  }

  if (action === "upload") {
    await transact(db => { requireUser(db, event.req, "admin"); return null; });
    const reader = event.req.body?.getReader();
    if (!reader) fail(400, "A file is required");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > pdfLimit + 65536) { await reader.cancel(); fail(413, "PDF must be 10 MB or smaller"); }
      chunks.push(chunk.value);
    }
    const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": event.req.headers.get("content-type") || "" } }).formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) fail(400, "No file attached");
    if (!file.type.includes("pdf")) fail(400, "Please upload a PDF repair-time sheet");
    if (file.size > pdfLimit) fail(413, "PDF is too large (10 MB maximum)");
    const requestedVehicle = text(form.get("vehicleId"), "Vehicle", 80, false);
    const id = randomUUID();
    const destination = join(dataDir, "repair-times-pdfs", `${id}.pdf`);
    try {
      return await transact(async db => {
        const user = requireUser(db, event.req, "admin");
        const vehicleId = requestedVehicle && db.vehicles.some(vehicle => vehicle.id === requestedVehicle) ? requestedVehicle : null;
        if (requestedVehicle && !vehicleId) fail(400, "Select an existing vehicle");
        const sheet = {
          id,
          vehicleId,
          name: filename(file.name),
          size: file.size,
          createdAt: new Date().toISOString(),
          createdBy: user.name,
        };
        await fs.mkdir(join(dataDir, "repair-times-pdfs"), { recursive: true, mode: 0o700 });
        await fs.writeFile(destination, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
        db.repairTimePdfs = db.repairTimePdfs || [];
        db.repairTimePdfs.unshift(sheet);
        logActivity(db, user, `Uploaded repair-time sheet ${sheet.name}`);
        return sheet;
      }, true);
    } catch (error) {
      await fs.rm(destination, { force: true });
      throw error;
    }
  }

  if (action === "delete") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) fail(400, "PDF ID is required");
    return transact(async db => {
      const user = requireUser(db, event.req, "admin");
      const sheet = (db.repairTimePdfs || []).find(pdf => pdf.id === id);
      if (!sheet) fail(404, "Repair-time PDF not found");
      db.repairTimePdfs = (db.repairTimePdfs || []).filter(pdf => pdf.id !== id);
      await fs.rm(join(dataDir, "repair-times-pdfs", `${sheet.id}.pdf`), { force: true });
      logActivity(db, user, `Deleted repair-time sheet ${sheet.name}`);
      return { ok: true };
    }, true);
  }

  fail(400, "Unknown action");
});
