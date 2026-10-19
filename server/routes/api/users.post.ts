import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { randomUUID } from "node:crypto";
import { fail, hashPassword, logActivity, publicUser, requireUser, text, transact, validatePassword } from "../../utils/store";
export default defineHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object") fail(400, "Invalid request");
  return transact(db => {
    const admin = requireUser(db, event.req, "admin");
    const action = text(body.action, "Action", 20, true);
    const id = text(body.id, "ID", 80);
    if (action === "delete") {
      const user = db.users.find(u => u.id === id);
      if (!user) fail(404, "Account not found");
      if (user.id === admin.id) fail(400, "You cannot delete your own account");
      db.users = db.users.filter(u => u.id !== id);
      db.sessions = db.sessions.filter(s => s.userId !== id);
      logActivity(db, admin, `Removed account for ${user.name}`);
      return { ok: true };
    }
    if (!["save", "password"].includes(action)) fail(400, "Unknown action");
    if (action === "password") {
      const user = db.users.find(u => u.id === id);
      if (!user) fail(404, "Account not found");
      user.password = hashPassword(validatePassword(body.password));
      db.sessions = db.sessions.filter(s => s.userId !== id);
      logActivity(db, admin, `Reset password for ${user.name}`);
      return { ok: true };
    }
    const role = text(body.role, "Role", 20, true);
    if (!["viewer", "editor", "admin"].includes(role)) fail(400, "Choose a valid role");
    const email = text(body.email, "Email", 200, true).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid email");
    if (db.users.some(u => u.email === email && u.id !== id)) fail(409, "That email already has an account");
    const existing = id ? db.users.find(u => u.id === id) : undefined;
    if (id && !existing) fail(404, "Account not found");
    if (id === admin.id && role !== "admin") fail(400, "You cannot remove your own administrator access");
    const user = { id: existing?.id || randomUUID(), name: text(body.name, "Name", 100, true), email,
      role: role as "admin" | "editor" | "viewer", password: existing?.password || hashPassword(validatePassword(body.password)) };
    db.users = [...db.users.filter(u => u.id !== user.id), user];
    if (existing && existing.role !== user.role) db.sessions = db.sessions.filter(s => s.userId !== user.id);
    logActivity(db, admin, `${existing ? "Updated" : "Created"} account for ${user.name}`);
    return publicUser(user);
  }, true);
});
