import { readBody } from "nitro/h3";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { defineHandler } from "nitro";
import { dataDir, fail, filename, logActivity, requireUser, transact, text } from "../../utils/store";
import { importRepairTimes, parseRepairTimeImport, refreshVehicleRepairTimes, applySheetRepairTimes } from "../../utils/repair-times";
import { parseRepairSheet, parseRepairText } from "../../utils/repair-sheet";
import { parseVehicleIdentification } from "../../utils/vehicle-sheet";
import { mergeTorqueSpecs, parseTorqueText } from "../../utils/torques";

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

  if (action === "paste") {
    // Text the user copied from the licensed program. Without `apply` this only
    // previews the rows; nothing is written to a vehicle until it is reviewed.
    const raw = typeof body.text === "string" ? body.text : "";
    if (!raw.trim()) fail(400, "Paste the rows from your repair-time program first");
    if (raw.length > 200_000) fail(413, "Paste up to 200,000 characters at a time");
    await transact(db => { requireUser(db, event.req, "admin"); return null; });
    const parsed = parseRepairText(raw, { allowEmpty: true });
    // A copied identification screen has no operation rows and a vehicle paste
    // has no times, so any one of operations, torques or vehicle details is
    // enough to preview.
    const identification = parseVehicleIdentification(raw);
    const torques = parseTorqueText(raw);
    if (!parsed.operations.length && !identification && !torques.length) fail(400, "No repair-time rows, tightening torques or vehicle details were recognised. Copy operation rows, a torque table or a vehicle identification screen.");
    if (body.apply !== true) return { operations: parsed.operations, skipped: parsed.skipped, torques, vehicle: identification, applied: 0 };
    const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId.trim() : "";
    // A details-only paste only creates or fills a vehicle, so it needs no target.
    const hasRows = parsed.operations.length > 0 || torques.length > 0;
    if (hasRows && !vehicleId) fail(400, "Choose the vehicle this paste belongs to");
    if (parsed.operations.length) {
      const applied = await applySheetRepairTimes(vehicleId, parsed.operations);
      if (!applied) fail(404, "That vehicle is not in this workshop");
    }
    if (hasRows) {
      await transact(db => {
        const user = requireUser(db, event.req, "admin");
        const vehicle = db.vehicles.find(item => item.id === vehicleId);
        if (!vehicle) fail(404, "That vehicle is not in this workshop");
        if (torques.length) {
          vehicle.torqueSpecs = mergeTorqueSpecs(vehicle.torqueSpecs || [], torques);
          vehicle.torqueSpecsUpdatedAt = new Date().toISOString();
        }
        const label = `${vehicle.make} ${vehicle.model}`.trim() || "a vehicle";
        if (parsed.operations.length) logActivity(db, user, `Pasted ${parsed.operations.length} repair-time operations onto ${label}`);
        if (torques.length) logActivity(db, user, `Pasted ${torques.length} tightening torques onto ${label}`);
        return null;
      }, true);
    }
    return { applied: parsed.operations.length, torques: torques.length, skipped: parsed.skipped, vehicleId, vehicle: identification };
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
    if (!file.type.includes("pdf") && !file.name.toLowerCase().endsWith(".pdf")) fail(400, "Please upload a PDF repair-time sheet");
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

  if (action === "extract") {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) fail(400, "Choose a repair-time PDF");
    const sheet = await transact(db => { requireUser(db, event.req, "admin"); return (db.repairTimePdfs || []).find(pdf => pdf.id === id); });
    if (!sheet) fail(404, "Repair-time PDF not found");
    let bytes: Buffer;
    try { bytes = await fs.readFile(join(dataDir, "repair-times-pdfs", `${sheet.id}.pdf`)); }
    catch { fail(404, "The stored PDF file is missing"); }
    const parsed = parseRepairSheet(bytes);
    return { sheet: { id: sheet.id, name: sheet.name, vehicleId: sheet.vehicleId }, pages: parsed.pages, operations: parsed.operations };
  }

  if (action === "apply") {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) fail(400, "Choose a repair-time PDF");
    // The sheet's own vehicle is the default target; the reader can pick another one.
    const requested = typeof body.vehicleId === "string" ? body.vehicleId.trim() : "";
    const targetVehicleId = await transact(db => {
      requireUser(db, event.req, "admin");
      const sheet = (db.repairTimePdfs || []).find(pdf => pdf.id === id);
      if (!sheet) fail(404, "Repair-time PDF not found");
      const target = requested || sheet.vehicleId;
      if (!target) fail(400, "Choose the vehicle these times belong to");
      const vehicle = db.vehicles.find(vehicle => vehicle.id === target);
      if (!vehicle) fail(404, "That vehicle is not in this workshop");
      return vehicle.id;
    });
    const bytes = await fs.readFile(join(dataDir, "repair-times-pdfs", `${id}.pdf`));
    const parsed = parseRepairSheet(bytes);
    await applySheetRepairTimes(targetVehicleId, parsed.operations);
    const applied = await transact(db => {
      const user = requireUser(db, event.req, "admin");
      const sheet = (db.repairTimePdfs || []).find(pdf => pdf.id === id);
      // Keep the sheet with the vehicle it was applied to, so later reads default to it.
      if (sheet && !sheet.vehicleId) sheet.vehicleId = targetVehicleId;
      const vehicle = db.vehicles.find(vehicle => vehicle.id === targetVehicleId);
      logActivity(db, user, `Applied ${parsed.operations.length} repair-time operations from ${sheet?.name || "a sheet"} to ${vehicle ? `${vehicle.make} ${vehicle.model}`.trim() : "a vehicle"}`);
      return { applied: parsed.operations.length, vehicleId: targetVehicleId };
    }, true);
    return { ...applied, skipped: parsed.skipped };
  }

  if (action === "delete") {
    const id = typeof body.id === "string" ? body.id.trim() : "";
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
