import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { createError } from "nitro/h3";
import type { Attachment, Activity, User, Vehicle, WorkshopRecord, Workspace } from "../../src/lib/workshop-types";

type StoredUser = User & { password: string };
type Session = { hash: string; userId: string; expires: number };
export interface Store {
  name: string; vmUrl: string; users: StoredUser[]; sessions: Session[];
  vehicles: Vehicle[]; records: WorkshopRecord[]; attachments: Attachment[]; activity: Activity[];
}
export const dataDir = path.resolve(process.env.NITRO_DATA_DIR || ".workshop-data");
let queue: Promise<unknown> = Promise.resolve();
export function transact<T>(operation: (store: Store) => T | Promise<T>, write = false): Promise<T> {
  const task = queue.then(async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    let db: Store;
    try { db = JSON.parse(await fs.readFile(path.join(dataDir, "workspace.json"), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      db = { name: "My workshop", vmUrl: "", users: [], sessions: [], vehicles: [], records: [], attachments: [], activity: [] };
    }
    const result = await operation(db);
    if (write) {
      const temporary = path.join(dataDir, `workspace-${randomUUID()}.tmp`);
      await fs.writeFile(temporary, JSON.stringify(db), { mode: 0o600 });
      await fs.rename(temporary, path.join(dataDir, "workspace.json"));
    }
    return result;
  });
  queue = task.catch(() => {});
  return task;
}
export function fail(statusCode: number, message: string): never { throw createError({ statusCode, statusMessage: message }); }
export function text(value: unknown, label: string, max = 500, required = false): string {
  if (typeof value !== "string") { if (required) fail(400, `${label} is required`); return ""; }
  const result = value.trim();
  if (result.length > max || (required && !result)) fail(400, `${label} must be ${required ? "1–" : "at most "}${max} characters`);
  return result;
}
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function matchesPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, "hex"));
}
export function validatePassword(value: unknown) {
  const password = typeof value === "string" ? value : "";
  if (password.length < 12 || password.length > 128) fail(400, "Use a password between 12 and 128 characters");
  return password;
}
export function publicUser(user: StoredUser): User { return { id: user.id, name: user.name, email: user.email, role: user.role }; }
export function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
export function currentUser(db: Store, request: Request): StoredUser | undefined {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
  if (!token || token.length > 200) return undefined;
  const session = db.sessions.find(s => s.hash === tokenHash(token) && s.expires > Date.now());
  return session ? db.users.find(u => u.id === session.userId) : undefined;
}
export function requireUser(db: Store, request: Request, access: "read" | "write" | "admin" = "read") {
  const user = currentUser(db, request);
  if (!user) fail(401, "Please sign in to your workshop");
  if (access === "write" && user.role === "viewer") fail(403, "An editor account is required");
  if (access === "admin" && user.role !== "admin") fail(403, "An administrator account is required");
  return user;
}
export function workspace(db: Store, user?: StoredUser): Workspace {
  return { setupRequired: db.users.length === 0, user: user ? publicUser(user) : null,
    name: user ? db.name : "My workshop", vmUrl: user ? db.vmUrl : "",
    vehicles: user ? db.vehicles : [], records: user ? db.records : [],
    attachments: user ? db.attachments : [], activity: user ? db.activity : [],
    users: user?.role === "admin" ? db.users.map(publicUser) : [],
  };
}
export function logActivity(db: Store, user: User, message: string) {
  db.activity.unshift({ id: randomUUID(), text: message, at: new Date().toISOString(), actor: user.name });
  db.activity = db.activity.slice(0, 100);
}
export function safeLink(value: unknown): string {
  const link = text(value, "VM URL", 1000);
  if (!link) return "";
  let url: URL;
  try { url = new URL(link); } catch { fail(400, "Enter a full http:// or https:// URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) fail(400, "Use an HTTP or HTTPS URL without embedded credentials");
  return url.toString();
}
