import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { randomUUID } from "node:crypto";
import { fail, logActivity, requireUser, text, transact } from "../../utils/store";

/*
 * The steps shared by every vehicle of one make and model. They live in one list
 * so the workshop can edit or prune them in a single place; "collect" seeds that
 * list from the steps already recorded on those vehicles.
 */
const key = (make: string, model: string) => `${make.trim().toLowerCase()}\u0000${model.trim().toLowerCase()}`;
const labelKey = (label: string) => label.trim().toLowerCase();

export default defineHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object") fail(400, "Invalid request");
  const action = text(body.action, "Action", 20, true);
  if (!["save", "delete", "collect"].includes(action)) fail(400, "Unknown operation");
  return transact(db => {
    const user = requireUser(db, event.req, "write");
    const id = text(body.id, "ID", 80);
    if (action === "delete") {
      const step = db.modelSteps.find(item => item.id === id);
      if (!step) fail(404, "Step not found");
      db.modelSteps = db.modelSteps.filter(item => item.id !== id);
      logActivity(db, user, `Removed shared step ${step.label}`);
      return { ok: true };
    }
    const make = text(body.make, "Make", 80, true);
    const model = text(body.model, "Model", 100, true);
    if (action === "collect") {
      // Every label already recorded on a vehicle of this model becomes a shared
      // step once, so the list starts from what the workshop actually knows.
      const existing = new Set(db.modelSteps.filter(step => key(step.make, step.model) === key(make, model)).map(step => labelKey(step.label)));
      const now = new Date().toISOString();
      const matched = db.vehicles.filter(vehicle => key(vehicle.make, vehicle.model) === key(make, model));
      const collected = [];
      for (const vehicle of matched) {
        for (const time of vehicle.repairTimes || []) {
          for (const step of time.includes || []) {
            const label = step.label.trim();
            if (!label || existing.has(labelKey(label))) continue;
            existing.add(labelKey(label));
            collected.push({ id: randomUUID(), make, model, label, scope: step.scope || "", minutes: Number(step.minutes) || 0,
              createdAt: now, createdBy: user.name });
          }
        }
      }
      if (collected.length) {
        db.modelSteps = [...collected, ...db.modelSteps];
        logActivity(db, user, `Collected ${collected.length} shared step${collected.length === 1 ? "" : "s"} for ${make} ${model}`);
      }
      return { added: collected.length, vehicles: matched.length, steps: db.modelSteps.filter(step => key(step.make, step.model) === key(make, model)) };
    }
    const existing = id ? db.modelSteps.find(item => item.id === id) : undefined;
    if (id && !existing) fail(404, "Step not found");
    const label = text(body.label, "Step", 200, true);
    const scope = text(body.scope, "Code", 40);
    const rawMinutes = body.minutes === "" || body.minutes === null || body.minutes === undefined ? 0 : Number(body.minutes);
    if (!Number.isInteger(rawMinutes) || rawMinutes < 0) fail(400, "Minutes must be a whole number of 0 or more");
    const clash = db.modelSteps.some(step => key(step.make, step.model) === key(make, model) && labelKey(step.label) === labelKey(label) && step.id !== existing?.id);
    if (clash) fail(400, "That step is already shared for this model");
    const now = new Date().toISOString();
    const step = {
      id: existing?.id || randomUUID(), make, model, label, scope, minutes: rawMinutes,
      createdAt: existing?.createdAt || now, createdBy: existing?.createdBy || user.name,
    };
    db.modelSteps = [step, ...db.modelSteps.filter(item => item.id !== step.id)];
    logActivity(db, user, `${existing ? "Updated" : "Added"} shared step ${step.label} for ${make} ${model}`);
    return step;
  }, true);
});
