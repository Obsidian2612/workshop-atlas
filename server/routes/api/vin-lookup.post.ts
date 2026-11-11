import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { fail, requireUser, transact } from "../../utils/store";
import { cleanVin, lookupVin } from "../../utils/vin-lookup";

/*
 * Read-only: the vehicle editor calls this with a VIN and shows the details it
 * could find. Only the reader's own save writes them onto the vehicle.
 */

const windows = new Map<string, number[]>();

function throttle(userId: string) {
  const now = Date.now();
  const recent = (windows.get(userId) || []).filter(at => now - at < 60_000);
  if (recent.length >= 6) fail(429, "Too many VIN lookups. Try again in a minute.");
  recent.push(now);
  windows.set(userId, recent);
  if (windows.size > 200) {
    for (const [key, list] of windows) if (!list.some(at => now - at < 60_000)) windows.delete(key);
  }
}

export default defineHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object") fail(400, "Invalid request");
  const vin = cleanVin(body.vin);
  // The look-up spends provider quota, so only editors and administrators may run it.
  const userId = await transact(db => requireUser(db, event.req, "write").id);
  throttle(userId);
  return await lookupVin(vin);
});
