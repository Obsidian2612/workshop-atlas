import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { fail, logActivity, requireUser, safeLink, text, transact } from "../../utils/store";
export default defineHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object") fail(400, "Invalid request");
  return transact(db => {
    const user = requireUser(db, event.req, "admin");
    db.name = text(body.name, "Workshop name", 100, true);
    db.vmUrl = safeLink(body.vmUrl);
    logActivity(db, user, "Updated workshop settings");
    return { ok: true };
  }, true);
});
