import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { fail, logActivity, requireUser, text, transact } from "../../utils/store";
import { fetchGeminiRepairTimes, fetchGeminiTorques } from "../../utils/gemini";
import type { RepairTimeEntry } from "../../../src/lib/workshop-types";

const maxRows = 100;

function reviewedRows(value: unknown): { operation: string; minutes: number }[] {
  if (!Array.isArray(value) || !value.length) fail(400, "Choose at least one repair time to add");
  if (value.length > maxRows) fail(400, `Add at most ${maxRows} repair times at a time`);
  return value.map(item => {
    if (!item || typeof item !== "object") fail(400, "Invalid repair-time row");
    const row = item as Record<string, unknown>;
    const operation = text(row.operation, "Operation", 200, true);
    const minutes = Number(row.minutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) fail(400, "Each repair time needs whole minutes between 0 and 1,440");
    return { operation, minutes };
  });
}

export default defineHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object") fail(400, "Invalid request");
  const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId.trim() : "";
  const kind = body.kind === "torques" ? "torques" : "times";

  if (body.apply === true) {
    // Reviewed rows are saved exactly as they were shown; Gemini is not called again.
    if (!vehicleId) fail(400, "Choose the vehicle these times belong to");
    const rows = reviewedRows(body.operations);
    const now = new Date().toISOString();
    return transact(db => {
      const user = requireUser(db, event.req, "write");
      const vehicle = db.vehicles.find(item => item.id === vehicleId);
      if (!vehicle) fail(404, "That vehicle is not in this workshop");
      const merged = new Map<string, RepairTimeEntry>();
      for (const entry of vehicle.repairTimes || []) merged.set(entry.operation.toLowerCase(), entry);
      for (const row of rows) merged.set(row.operation.toLowerCase(), { operation: row.operation, minutes: row.minutes, source: "gemini" as const });
      vehicle.repairTimes = [...merged.values()].sort((a, b) => a.operation.localeCompare(b.operation));
      vehicle.repairTimesSource = [...new Set(vehicle.repairTimes.map(entry => entry.source))].join(" + ");
      vehicle.repairTimesUpdatedAt = now;
      logActivity(db, user, `Added ${rows.length} Gemini repair times to ${`${vehicle.make} ${vehicle.model}`.trim() || "a vehicle"}`);
      return { applied: rows.length };
    }, true);
  }

  let target: { vin: string; make: string; model: string; year: string; engine: string; engineModel: string; engineNumber: string };
  if (vehicleId) {
    target = await transact(db => {
      // A lookup spends API quota, so only editors and administrators can run it.
      requireUser(db, event.req, "write");
      const vehicle = db.vehicles.find(item => item.id === vehicleId);
      if (!vehicle) fail(404, "That vehicle is not in this workshop");
      return { vin: vehicle.vin, make: vehicle.make, model: vehicle.model, year: vehicle.year, engine: vehicle.engine, engineModel: vehicle.engineModel, engineNumber: vehicle.engineNumber };
    });
  } else {
    await transact(db => requireUser(db, event.req, "write"));
    target = {
      vin: text(body.vin, "VIN", 30),
      make: text(body.make, "Make", 100),
      model: text(body.model, "Model", 100),
      year: text(body.year, "Year", 20),
      engine: text(body.engine, "Engine", 100),
      engineModel: text(body.engineModel, "Engine model", 100),
      engineNumber: text(body.engineNumber, "Engine number", 60),
    };
  }
  if (kind === "torques") {
    // Torque tables are identified by the vehicle itself, so a VIN is optional here.
    if (!target.vin && !target.make && !target.model) fail(400, "Add a VIN or a make and model before looking up tightening torques");
    const specs = await fetchGeminiTorques(target.vin, target.make, target.model, target.year, target.engine, target.engineModel, target.engineNumber);
    if (!specs.length) fail(502, "Gemini did not return any tightening torques. Add the engine, model or year and try again.");
    return { specs };
  }
  if (!target.vin) fail(400, "Add a VIN to this vehicle before looking up repair times");
  const operations = await fetchGeminiRepairTimes(target.vin, target.make, target.model, target.year);
  if (!operations.length) fail(502, "Gemini did not recognise this vehicle. Add the engine, model or year and try again.");
  return { operations };
});