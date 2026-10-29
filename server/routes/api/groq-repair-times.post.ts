import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { fail, requireUser, transact } from "../../utils/store";
import { searchRepairTimes } from "../../utils/groq-repair-times";

const windows = new Map<string, number[]>();

function throttle(userId: string) {
  const now = Date.now();
  const recent = (windows.get(userId) || []).filter(at => now - at < 60_000);
  if (recent.length >= 6) fail(429, "Too many online repair-time searches. Try again in a minute.");
  recent.push(now);
  windows.set(userId, recent);
  if (windows.size > 200) {
    for (const [key, list] of windows) if (!list.some(at => now - at < 60_000)) windows.delete(key);
  }
}

export default defineHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object") fail(400, "Invalid request");
  const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId.trim() : "";
  if (!vehicleId) fail(400, "Choose a vehicle to search for");
  const snapshot = await transact(db => {
    // Provider calls spend quota, so only editors and administrators can run them.
    const user = requireUser(db, event.req, "write");
    const vehicle = db.vehicles.find(item => item.id === vehicleId);
    if (!vehicle) fail(404, "That vehicle is not in this workshop");
    return {
      userId: user.id,
      vehicle: { make: vehicle.make, model: vehicle.model, year: vehicle.year, engine: vehicle.engine, engineModel: vehicle.engineModel, engineNumber: vehicle.engineNumber, vin: vehicle.vin },
    };
  });
  throttle(snapshot.userId);
  return searchRepairTimes(snapshot.vehicle);
});
