import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { fail, requireUser, transact } from "../../utils/store";
import { importRepairTimes, parseRepairTimeImport, refreshVehicleRepairTimes } from "../../utils/repair-times";

export default defineHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object") fail(400, "Invalid request");
  const action = typeof body.action === "string" ? body.action : "";
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
  fail(400, "Unknown action");
});
