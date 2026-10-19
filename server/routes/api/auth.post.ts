import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { randomBytes, randomUUID } from "node:crypto";
import { currentUser, fail, hashPassword, logActivity, matchesPassword, publicUser, text, tokenHash, transact, validatePassword } from "../../utils/store";

const attempts = new Map<string, { count: number; until: number }>();
let globalWindow = { count: 0, until: 0 };
export default defineHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object") fail(400, "Invalid request");
  const action = text(body.action, "Action", 20, true);
  if (!["login", "setup", "logout"].includes(action)) fail(400, "Unknown action");
  if (action !== "logout") {
    const now = Date.now();
    if (globalWindow.until < now) globalWindow = { count: 0, until: now + 60000 };
    if (++globalWindow.count > 40) fail(429, "Too many sign-in attempts. Try again in a minute");
  }
  return transact(db => {
    if (action === "logout") {
      const token = event.req.headers.get("authorization")?.replace(/^Bearer /, "") || "";
      db.sessions = db.sessions.filter(s => s.hash !== tokenHash(token));
      return { ok: true };
    }
    const email = text(body.email, "Email", 200, true).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid email address");
    const now = Date.now();
    const prior = attempts.get(email);
    if (prior && prior.until > now && prior.count >= 8) fail(429, "Too many sign-in attempts. Try again in 15 minutes");
    for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
    let user = db.users.find(u => u.email === email);
    if (action === "setup") {
      if (db.users.length) fail(409, "The workshop is already set up. Please sign in");
      const key = process.env.NITRO_SETUP_KEY;
      if (key && tokenHash(String(body.setupKey || "")) !== tokenHash(key)) fail(403, "The setup key is incorrect");
      user = { id: randomUUID(), name: text(body.name, "Name", 100, true), email, role: "admin", password: hashPassword(validatePassword(body.password)) };
      db.users.push(user);
      db.name = text(body.workshopName, "Workshop name", 100, true);
      logActivity(db, user, "Created the workshop workspace");
    } else {
      const password = typeof body.password === "string" ? body.password : "";
      if (!user || password.length > 128 || !matchesPassword(password, user.password)) {
        attempts.set(email, { count: (prior && prior.until > now ? prior.count : 0) + 1, until: now + 15 * 60000 });
        fail(401, "Email or password is incorrect");
      }
      attempts.delete(email);
    }
    const token = randomBytes(32).toString("hex");
    db.sessions = db.sessions.filter(s => s.expires > now);
    db.sessions.push({ hash: tokenHash(token), userId: user.id, expires: now + 12 * 60 * 60 * 1000 });
    return { token, user: publicUser(user) };
  }, true);
});
