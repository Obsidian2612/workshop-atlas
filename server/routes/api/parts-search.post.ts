import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { fail, requireUser, transact } from "../../utils/store";
import { searchParts } from "../../utils/parts-search";

const windows = new Map<string, number[]>();

function throttle(userId: string) {
  const now = Date.now();
  const recent = (windows.get(userId) || []).filter(at => now - at < 60_000);
  if (recent.length >= 6) fail(429, "Too many supplier searches. Try again in a minute.");
  recent.push(now);
  windows.set(userId, recent);
  if (windows.size > 200) {
    for (const [key, list] of windows) if (!list.some(at => now - at < 60_000)) windows.delete(key);
  }
}

export default defineHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object") fail(400, "Invalid request");
  const term = typeof body.term === "string" ? body.term.trim() : "";
  if (term.length < 2) fail(400, "Type the name of the part, for example clutch kit or dipstick");
  const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId.trim() : "";
  const snapshot = await transact(db => {
    // Provider calls cost quota, so only editors and administrators can run them.
    const user = requireUser(db, event.req, "write");
    const vehicle = vehicleId ? db.vehicles.find(item => item.id === vehicleId) : undefined;
    if (vehicleId && !vehicle) fail(404, "That vehicle is not in this workshop");
    return {
      userId: user.id,
      term,
      vehicle: vehicle ? { make: vehicle.make, model: vehicle.model, year: vehicle.year, engine: vehicle.engine } : null,
      suppliers: db.suppliers.map(supplier => ({ id: supplier.id, name: supplier.name, website: supplier.website })),
    };
  });
  throttle(snapshot.userId);
  return searchParts(snapshot);
});
