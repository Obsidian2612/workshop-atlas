import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { fail, logActivity, requireUser, transact } from "../../utils/store";
import { mergeTorqueSpecs, preserveTorqueOrigins, sanitizeTorqueSpecs, stampTorqueSpecs } from "../../utils/torques";

const rowKey = (fastener: string, stage: string) => `${fastener.toLowerCase()}|${stage.toLowerCase()}`;

export default defineHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object") fail(400, "Invalid request");
  const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId.trim() : "";
  if (!vehicleId) fail(400, "Choose the vehicle these torques belong to");
  // A check is one person's judgement on one row, not a rewrite of the table.
  const checking = body.action === "check" || body.action === "uncheck";
  const merge = body.action === "merge";
  const specs = checking ? [] : sanitizeTorqueSpecs(body.specs);
  const fastener = checking && typeof body.fastener === "string" ? body.fastener.replace(/\s+/g, " ").trim() : "";
  const stage = checking && typeof body.stage === "string" ? body.stage.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  if (checking && (fastener.length < 2 || fastener.length > 200)) fail(400, "Choose the torque row to mark as checked");
  return transact(db => {
    const user = requireUser(db, event.req, "write");
    const vehicle = db.vehicles.find(item => item.id === vehicleId);
    if (!vehicle) fail(404, "That vehicle is not in this workshop");
    const label = `${vehicle.make} ${vehicle.model}`.trim() || "a vehicle";

    if (checking) {
      const row = (vehicle.torqueSpecs || []).find(spec => rowKey(spec.fastener, spec.stage) === rowKey(fastener, stage));
      if (!row) fail(404, "That torque row is no longer on this vehicle");
      const checked = body.action === "check";
      if (checked) {
        row.checkedBy = user.name;
        row.checkedAt = new Date().toISOString();
      } else {
        delete row.checkedBy;
        delete row.checkedAt;
      }
      vehicle.torqueSpecsUpdatedAt = new Date().toISOString();
      logActivity(db, user, `${checked ? "Checked" : "Unchecked"} the ${row.fastener} torque on ${label}`);
      return { vehicleId, specs: vehicle.torqueSpecs };
    }

    vehicle.torqueSpecs = stampTorqueSpecs(
      merge ? mergeTorqueSpecs(vehicle.torqueSpecs || [], specs) : preserveTorqueOrigins(vehicle.torqueSpecs || [], specs),
      user.name,
    );
    vehicle.torqueSpecsUpdatedAt = new Date().toISOString();
    logActivity(db, user, `Updated tightening torques for ${label}`);
    return { vehicleId, specs: vehicle.torqueSpecs };
  }, true);
});
