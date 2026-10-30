import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { fail, logActivity, requireUser, transact } from "../../utils/store";
import { sanitizeTorqueSpecs, mergeTorqueSpecs } from "../../utils/torques";
import { cleanRepairTimeRows, mergeRepairTimes } from "../../utils/groq-repair-times";
import { cleanSpecSections, formatSpecSheet, searchVehicleSpec } from "../../utils/groq-vehicle-spec";

/*
 * Two-step lookup, like the other online searches: without `apply` this only
 * previews the sheet, and the vehicle is written exactly once the reader
 * confirms which sections and torques they trust.
 */

const windows = new Map<string, number[]>();
const marker = "— Specifications pulled from the web with Groq —";
const specLimit = 20000;

function throttle(userId: string) {
  const now = Date.now();
  const recent = (windows.get(userId) || []).filter(at => now - at < 60_000);
  if (recent.length >= 4) fail(429, "Too many online specification searches. Try again in a minute.");
  recent.push(now);
  windows.set(userId, recent);
  if (windows.size > 200) {
    for (const [key, list] of windows) if (!list.some(at => now - at < 60_000)) windows.delete(key);
  }
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

export default defineHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object") fail(400, "Invalid request");
  const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId.trim() : "";
  if (!vehicleId) fail(400, "Choose a vehicle to look up");

  const snapshot = await transact(db => {
    // Provider calls spend quota, so only editors and administrators can run them.
    const user = requireUser(db, event.req, "write");
    const vehicle = db.vehicles.find(item => item.id === vehicleId);
    if (!vehicle) fail(404, "That vehicle is not in this workshop");
    return {
      userId: user.id,
      vehicle: {
        vin: vehicle.vin, make: vehicle.make, model: vehicle.model, year: vehicle.year,
        engine: vehicle.engine, engineModel: vehicle.engineModel, engineNumber: vehicle.engineNumber,
      },
    };
  });

  if (body.apply === true) {
    const sections = Array.isArray(body.sections) ? cleanSpecSections(body.sections) : [];
    const torques = Array.isArray(body.torques) ? sanitizeTorqueSpecs(body.torques) : [];
    const repairTimes = Array.isArray(body.repairTimes) ? cleanRepairTimeRows(body.repairTimes) : [];
    const identification = body.identification && typeof body.identification === "object"
      ? body.identification as Record<string, unknown>
      : {};
    return transact(db => {
      const user = requireUser(db, event.req, "write");
      const vehicle = db.vehicles.find(item => item.id === vehicleId);
      if (!vehicle) fail(404, "That vehicle is not in this workshop");

      // Re-applying the sheet replaces the previous Groq block instead of
      // stacking duplicates, and keeps any notes the reader wrote themselves.
      if (sections.length) {
        const block = [formatSpecSheet(vehicle, sections), "", marker, "Values are AI-sourced from the web; verify against an authorised source before relying on them."].join("\n");
        const prior = vehicle.specifications.includes(marker)
          ? vehicle.specifications.slice(0, vehicle.specifications.indexOf(marker)).trim()
          : vehicle.specifications.trim();
        const room = specLimit - block.length - (prior ? 2 : 0);
        if (room < 0) fail(400, "This specification sheet is too large to save. Choose fewer sections and try again.");
        // An existing note that no longer fits is trimmed from the end, never dropped silently.
        vehicle.specifications = [prior.slice(0, room).trim(), block].filter(Boolean).join("\n\n");
      }

      if (repairTimes.length) {
        vehicle.repairTimes = mergeRepairTimes(vehicle.repairTimes || [], repairTimes);
        vehicle.repairTimesSource = [...new Set(vehicle.repairTimes.map(entry => entry.source))].join(" + ");
        vehicle.repairTimesUpdatedAt = new Date().toISOString();
      }

      if (torques.length) {
        vehicle.torqueSpecs = mergeTorqueSpecs(vehicle.torqueSpecs || [], torques);
        vehicle.torqueSpecsUpdatedAt = new Date().toISOString();
      }
      // Only fill identity fields the workshop never recorded; the reader's data wins.
      const vin = cleanText(identification.vin, 30).toUpperCase();
      const engine = cleanText(identification.engine, 100);
      const engineModel = cleanText(identification.engineModel, 100);
      const engineNumber = cleanText(identification.engineNumber, 60);
      if (!vehicle.vin && vin) vehicle.vin = vin;
      if (!vehicle.engine && engine) vehicle.engine = engine;
      if (!vehicle.engineModel && engineModel) vehicle.engineModel = engineModel;
      if (!vehicle.engineNumber && engineNumber) vehicle.engineNumber = engineNumber;

      const label = `${vehicle.make} ${vehicle.model}`.trim() || "a vehicle";
      const added = [
        sections.length ? "online specifications" : "",
        torques.length ? `${torques.length} tightening torques` : "",
        repairTimes.length ? `${repairTimes.length} repair times` : "",
      ].filter(Boolean);
      if (added.length) logActivity(db, user, `Added ${added.join(" and ")} for ${label}`);
      return { applied: sections.length, rows: sections.reduce((sum, section) => sum + section.rows.length, 0), torques: torques.length, repairTimes: repairTimes.length };
    }, true);
  }

  throttle(snapshot.userId);
  return { sheet: await searchVehicleSpec(snapshot.vehicle) };
});
