import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { fail, logActivity, requireUser, transact } from "../../utils/store";
import { mergeTorqueSpecs, sanitizeTorqueSpecs } from "../../utils/torques";

export default defineHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object") fail(400, "Invalid request");
  const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId.trim() : "";
  if (!vehicleId) fail(400, "Choose the vehicle these torques belong to");
  const merge = body.action === "merge";
  const specs = sanitizeTorqueSpecs(body.specs);
  return transact(db => {
    const user = requireUser(db, event.req, "write");
    const vehicle = db.vehicles.find(item => item.id === vehicleId);
    if (!vehicle) fail(404, "That vehicle is not in this workshop");
    vehicle.torqueSpecs = merge ? mergeTorqueSpecs(vehicle.torqueSpecs || [], specs) : specs;
    vehicle.torqueSpecsUpdatedAt = new Date().toISOString();
    logActivity(db, user, `Updated tightening torques for ${`${vehicle.make} ${vehicle.model}`.trim() || "a vehicle"}`);
    return { vehicleId, specs: vehicle.torqueSpecs };
  }, true);
});
