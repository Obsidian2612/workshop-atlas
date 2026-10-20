import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir, fail, logActivity, requireUser, text, transact } from "../../utils/store";
import { refreshVehicleRepairTimes } from "../../utils/repair-times";

export default defineHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object") fail(400, "Invalid request");
  const entity = text(body.entity, "Entity", 20, true);
  const action = text(body.action, "Action", 20, true);
  if (!["vehicle", "record", "attachment"].includes(entity) || !["save", "delete"].includes(action)) fail(400, "Unknown operation");
  const removedFiles: string[] = [];
  const removedSheets: string[] = [];
  const result = await transact(db => {
    const user = requireUser(db, event.req, "write");
    const id = text(body.id, "ID", 80);
    if (action === "delete") {
      const items = entity === "vehicle" ? db.vehicles : entity === "record" ? db.records : db.attachments;
      const item = items.find(v => v.id === id);
      if (!item) fail(404, "Record not found");
      const linkedIds = entity === "vehicle" ? db.records.filter(r => r.vehicleId === id).map(r => r.id) : [];
      const deleteIds = new Set([id, ...linkedIds]);
      const files = db.attachments.filter(a => entity === "attachment" ? a.id === id : deleteIds.has(a.recordId));
      removedFiles.push(...files.map(f => f.id));
      db.attachments = db.attachments.filter(a => !files.some(f => f.id === a.id));
      if (entity === "vehicle") {
        db.vehicles = db.vehicles.filter(v => v.id !== id); db.records = db.records.filter(r => r.vehicleId !== id);
        const sheets = (db.repairTimePdfs || []).filter(pdf => pdf.vehicleId === id);
        removedSheets.push(...sheets.map(sheet => sheet.id));
        db.repairTimePdfs = (db.repairTimePdfs || []).filter(pdf => pdf.vehicleId !== id);
      }
      if (entity === "record") db.records = db.records.filter(r => r.id !== id);
      const label = "title" in item ? item.title : "model" in item ? `${item.make} ${item.model}` : item.name;
      logActivity(db, user, `Deleted ${label}`);
      return { ok: true };
    }
    if (entity === "attachment") fail(400, "Use the file upload endpoint");
    const now = new Date().toISOString();
    const collection = entity === "vehicle" ? db.vehicles : db.records;
    const existing = id ? collection.find(v => v.id === id) : undefined;
    if (id && !existing) fail(404, "Record not found");
    const common = { id: existing?.id || randomUUID(), createdAt: existing?.createdAt || now, updatedAt: now, createdBy: existing?.createdBy || user.name };
    if (entity === "vehicle") {
      const year = text(body.year, "Year", 4);
      if (year && !/^\d{4}$/.test(year)) fail(400, "Year must have four digits");
      const vehicle = { ...common, make: text(body.make, "Make", 80, true), model: text(body.model, "Model", 100, true), year,
        engine: text(body.engine, "Engine", 100), registration: text(body.registration, "Registration", 30), vin: text(body.vin, "VIN", 30),
        customer: text(body.customer, "Customer", 200), specifications: text(body.specifications, "Specifications", 20000) };
      const vin = vehicle.vin ? vehicle.vin.toUpperCase() : "";
      const imported = vin ? db.repairTimesByVin?.[vin] : undefined;
      if (imported?.length) {
        Object.assign(vehicle, { repairTimes: imported.map(entry => ({ ...entry, source: "imported" as const })), repairTimesSource: "imported", repairTimesUpdatedAt: now });
      }
      db.vehicles = [vehicle, ...db.vehicles.filter(v => v.id !== vehicle.id)];
      logActivity(db, user, `${existing ? "Updated" : "Added"} ${vehicle.make} ${vehicle.model}`);
      return vehicle;
    }
    const kind = text(body.kind, "Record kind", 20, true);
    if (!["procedure", "note", "service"].includes(kind)) fail(400, "Invalid record type");
    const vehicleId = text(body.vehicleId, "Vehicle", 80);
    if (vehicleId && !db.vehicles.some(v => v.id === vehicleId)) fail(400, "The selected vehicle does not exist");
    if (kind === "service" && !vehicleId) fail(400, "Select a vehicle for this service entry");
    const date = text(body.date, "Date", 10);
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) fail(400, "Enter a valid date");
    const rawRepairTime = body.repairTimeMinutes ?? body.repairTime;
    const repairTimeMinutes = rawRepairTime === undefined || rawRepairTime === null || rawRepairTime === "" ? 0 : Number(rawRepairTime);
    if (!Number.isInteger(repairTimeMinutes) || repairTimeMinutes < 0 || repairTimeMinutes > 1440) fail(400, "Repair time must be a whole number of minutes between 0 and 1440");
    const record = { ...common, kind: kind as "procedure" | "note" | "service", vehicleId,
      title: text(body.title, "Title", 200, true), category: text(body.category, "Category", 100),
      content: text(body.content, "Content", 30000, true), date, mileage: text(body.mileage, "Mileage", 40),
      repairTimeMinutes: kind === "service" ? repairTimeMinutes : 0 };
    db.records = [record, ...db.records.filter(r => r.id !== record.id)];
    logActivity(db, user, `${existing ? "Updated" : "Added"} ${record.title}`);
    return record;
  }, true);
  await Promise.all(removedFiles.map(id => fs.rm(path.join(dataDir, "attachments", `${id}.bin`), { force: true })));
  await Promise.all(removedSheets.map(id => fs.rm(path.join(dataDir, "repair-times-pdfs", `${id}.pdf`), { force: true })));
  if (entity === "vehicle" && action === "save" && process.env.REPAIR_API_URL) {
    const saved = result as { id?: string; vin?: string };
    if (saved?.id && saved.vin) void refreshVehicleRepairTimes(saved.id, true).catch(error => console.warn("Repair-time refresh failed", error));
  }
  return result;
});
