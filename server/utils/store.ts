import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createError } from "nitro/h3";
import type { Activity, Attachment, RepairTimeEntry, RepairTimePdf, User, Vehicle, WorkshopRecord, Workspace } from "../../src/lib/workshop-types";

/*
 * Workshop data lives in one SQLite database (`workshop.sqlite`) next to the private
 * attachment directories. SQLite owns durability: every request runs inside a
 * transaction, writes are serialized by the database (BEGIN IMMEDIATE), and only
 * rows that actually changed are written, so growth in one table never forces a
 * rewrite of the rest of the workspace.
 *
 * Routes keep working with the in-memory `Store` they always had: a transaction
 * reads the tables into that shape, the route mutates it, and the changed rows are
 * written back before COMMIT. A first start with a legacy `workspace.json` imports
 * it once and leaves the file in place as a pre-migration copy.
 */

type StoredUser = User & { password: string };
type Session = { hash: string; userId: string; expires: number };
export interface Store {
  name: string; vmUrl: string; users: StoredUser[]; sessions: Session[];
  vehicles: Vehicle[]; records: WorkshopRecord[]; attachments: Attachment[]; activity: Activity[];
  repairTimeMinutes: number;
  // Licensed repair-time data keyed by upper-case VIN. Entries carry no source;
  // the source is attached when they are copied onto a vehicle.
  repairTimesByVin?: Record<string, Omit<RepairTimeEntry, "source">[]>;
  // Uploaded repair-time sheets (PDF prints) with the vehicle they belong to.
  repairTimePdfs?: RepairTimePdf[];
}

export const dataDir = path.resolve(process.env.NITRO_DATA_DIR || ".workshop-data");
export const databaseFile = path.join(dataDir, "workshop.sqlite");

const schema = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  password TEXT NOT NULL, sort INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY, make TEXT NOT NULL, model TEXT NOT NULL, year TEXT NOT NULL, engine TEXT NOT NULL,
  registration TEXT NOT NULL, vin TEXT NOT NULL, customer TEXT NOT NULL, specifications TEXT NOT NULL,
  repair_times TEXT, repair_times_source TEXT, repair_times_updated_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL, sort INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, vehicle_id TEXT NOT NULL, category TEXT NOT NULL,
  content TEXT NOT NULL, date TEXT NOT NULL, mileage TEXT NOT NULL, repair_time_minutes INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL, sort INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, record_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, sort INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, sort INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS repair_times (
  vin TEXT NOT NULL, operation TEXT NOT NULL, minutes INTEGER NOT NULL, PRIMARY KEY (vin, operation)
);
CREATE TABLE IF NOT EXISTS repair_time_pdfs (
  id TEXT PRIMARY KEY, vehicle_id TEXT, name TEXT NOT NULL, size INTEGER NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, sort INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS records_vehicle ON records(vehicle_id);
CREATE INDEX IF NOT EXISTS attachments_record ON attachments(record_id);
CREATE INDEX IF NOT EXISTS repair_time_pdfs_vehicle ON repair_time_pdfs(vehicle_id);
CREATE INDEX IF NOT EXISTS vehicles_vin ON vehicles(vin);
`;

type Row = Record<string, string | number | null>;

function emptyStore(): Store {
  return {
    name: "My workshop", vmUrl: "", users: [], sessions: [], vehicles: [], records: [],
    attachments: [], activity: [], repairTimeMinutes: 0, repairTimesByVin: {}, repairTimePdfs: [],
  };
}

let connection: DatabaseSync | undefined;

function database(): DatabaseSync {
  if (connection) return connection;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databaseFile);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(schema);
  chmodSync(databaseFile, 0o600);
  importLegacyStore(db);
  connection = db;
  return db;
}

function metaValue(db: DatabaseSync, key: string) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
  return row ? String(row.value) : undefined;
}

function writeMetaValue(db: DatabaseSync, key: string, value: string) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// A legacy workspace.json is imported exactly once. Its presence is recorded in
// `meta`, so deleting or restoring the file later cannot resurrect old records.
function importLegacyStore(db: DatabaseSync) {
  if (metaValue(db, "legacy_json_imported")) return;
  const hasRows = Boolean(db.prepare("SELECT 1 FROM users LIMIT 1").get() || db.prepare("SELECT 1 FROM vehicles LIMIT 1").get());
  const legacyFile = path.join(dataDir, "workspace.json");
  let raw: string | undefined;
  try { raw = readFileSync(legacyFile, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!raw || hasRows) {
    db.exec("BEGIN IMMEDIATE");
    try { writeMetaValue(db, "legacy_json_imported", new Date().toISOString()); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }
    return;
  }
  let parsed: Partial<Store>;
  try { parsed = JSON.parse(raw) as Partial<Store>; }
  catch (error) { throw new Error(`The existing workspace.json could not be read: ${(error as Error).message}`); }
  if (!Array.isArray(parsed.users) || !Array.isArray(parsed.vehicles)) throw new Error("The existing workspace.json does not look like workshop data");
  const imported: Store = {
    ...emptyStore(), ...parsed,
    users: parsed.users, sessions: parsed.sessions || [], vehicles: parsed.vehicles,
    records: (parsed.records || []).map(record => ({ ...record, repairTimeMinutes: Number(record.repairTimeMinutes) || 0 })),
    attachments: parsed.attachments || [], activity: parsed.activity || [],
    repairTimesByVin: parsed.repairTimesByVin || {},
    // Older data stored only the sheet id and vehicle, so fill the metadata it never had.
    repairTimePdfs: (parsed.repairTimePdfs || []).map(sheet => ({
      id: String(sheet.id), vehicleId: sheet.vehicleId ?? null,
      name: sheet.name || "Repair-time sheet.pdf", size: Number(sheet.size) || 0,
      createdAt: sheet.createdAt || new Date().toISOString(), createdBy: sheet.createdBy || "Imported",
    })),
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    writeStore(db, emptyStore(), imported);
    writeMetaValue(db, "legacy_json_imported", new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function readStore(db: DatabaseSync): Store {
  const meta = new Map<string, string>();
  for (const row of db.prepare("SELECT key, value FROM meta").all() as unknown as Row[]) meta.set(String(row.key), String(row.value));
  const store = emptyStore();
  store.name = meta.get("name") || store.name;
  // An operator can seed the VM shortcut once with NITRO_VM_URL; saving the
  // setting in the app replaces it, so the stored value always wins.
  store.vmUrl = meta.get("vmUrl") || (process.env.NITRO_VM_URL || "").trim();
  store.repairTimeMinutes = Number(meta.get("repairTimeMinutes")) || 0;

  store.users = (db.prepare("SELECT * FROM users ORDER BY sort DESC").all() as unknown as Row[]).map(row => ({
    id: String(row.id), name: String(row.name), email: String(row.email),
    role: String(row.role) as User["role"], password: String(row.password),
  }));
  store.sessions = (db.prepare("SELECT hash, user_id, expires FROM sessions").all() as unknown as Row[]).map(row => ({
    hash: String(row.hash), userId: String(row.user_id), expires: Number(row.expires),
  }));
  store.vehicles = (db.prepare("SELECT * FROM vehicles ORDER BY sort DESC").all() as unknown as Row[]).map(row => {
    const vehicle: Vehicle = {
      id: String(row.id), make: String(row.make), model: String(row.model), year: String(row.year),
      engine: String(row.engine), registration: String(row.registration), vin: String(row.vin),
      customer: String(row.customer), specifications: String(row.specifications),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), createdBy: String(row.created_by),
    };
    if (row.repair_times !== null) {
      vehicle.repairTimes = JSON.parse(String(row.repair_times)) as RepairTimeEntry[];
      if (row.repair_times_source !== null) vehicle.repairTimesSource = String(row.repair_times_source);
      if (row.repair_times_updated_at !== null) vehicle.repairTimesUpdatedAt = String(row.repair_times_updated_at);
    }
    return vehicle;
  });
  store.records = (db.prepare("SELECT * FROM records ORDER BY sort DESC").all() as unknown as Row[]).map(row => ({
    id: String(row.id), kind: String(row.kind) as WorkshopRecord["kind"], title: String(row.title),
    vehicleId: String(row.vehicle_id), category: String(row.category), content: String(row.content),
    date: String(row.date), mileage: String(row.mileage), repairTimeMinutes: Number(row.repair_time_minutes),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), createdBy: String(row.created_by),
  }));
  store.attachments = (db.prepare("SELECT * FROM attachments ORDER BY sort DESC").all() as unknown as Row[]).map(row => ({
    id: String(row.id), recordId: String(row.record_id), name: String(row.name), type: String(row.type),
    size: Number(row.size), createdAt: String(row.created_at), createdBy: String(row.created_by),
  }));
  store.activity = (db.prepare("SELECT * FROM activity ORDER BY sort DESC").all() as unknown as Row[]).map(row => ({
    id: String(row.id), text: String(row.text), actor: String(row.actor), at: String(row.at),
  }));
  store.repairTimePdfs = (db.prepare("SELECT * FROM repair_time_pdfs ORDER BY sort DESC").all() as unknown as Row[]).map(row => ({
    id: String(row.id), vehicleId: row.vehicle_id === null ? null : String(row.vehicle_id),
    name: String(row.name), size: Number(row.size), createdAt: String(row.created_at), createdBy: String(row.created_by),
  }));

  const repairTimes: Record<string, Omit<RepairTimeEntry, "source">[]> = {};
  for (const row of db.prepare("SELECT vin, operation, minutes FROM repair_times ORDER BY rowid ASC").all() as unknown as Row[]) {
    const vin = String(row.vin);
    repairTimes[vin] = repairTimes[vin] || [];
    repairTimes[vin].push({ operation: String(row.operation), minutes: Number(row.minutes) });
  }
  store.repairTimesByVin = repairTimes;
  return store;
}

// Arrays are ordered newest-first (or as the routes arranged them). `sort` keeps
// that order in SQLite, and is refreshed only when the order actually moves.
function sortValues(rows: { id: string }[]) {
  const values = new Map<string, number>();
  rows.forEach((row, index) => values.set(row.id, rows.length - index));
  return values;
}

function removeMissing(db: DatabaseSync, table: "users" | "vehicles" | "records" | "attachments" | "activity" | "repair_time_pdfs", before: { id: string }[], after: { id: string }[]) {
  const kept = new Set(after.map(row => row.id));
  const statement = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
  for (const row of before) if (!kept.has(row.id)) statement.run(row.id);
}

function writeUsers(db: DatabaseSync, before: Store, after: Store) {
  removeMissing(db, "users", before.users, after.users);
  const upsert = db.prepare(`INSERT INTO users (id, name, email, role, password, sort) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email, role = excluded.role, password = excluded.password, sort = excluded.sort`);
  const move = db.prepare("UPDATE users SET sort = ? WHERE id = ?");
  const prior = new Map(before.users.map(user => [user.id, user]));
  const priorSort = sortValues(before.users);
  const nextSort = sortValues(after.users);
  for (const user of after.users) {
    const previous = prior.get(user.id);
    const sort = nextSort.get(user.id) ?? 0;
    if (!previous || previous.name !== user.name || previous.email !== user.email || previous.role !== user.role || previous.password !== user.password) {
      upsert.run(user.id, user.name, user.email, user.role, user.password, sort);
    } else if (priorSort.get(user.id) !== sort) move.run(sort, user.id);
  }
}

function writeSessions(db: DatabaseSync, before: Store, after: Store) {
  const kept = new Set(after.sessions.map(session => session.hash));
  const remove = db.prepare("DELETE FROM sessions WHERE hash = ?");
  for (const session of before.sessions) if (!kept.has(session.hash)) remove.run(session.hash);
  const upsert = db.prepare(`INSERT INTO sessions (hash, user_id, expires) VALUES (?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET user_id = excluded.user_id, expires = excluded.expires`);
  const prior = new Map(before.sessions.map(session => [session.hash, session]));
  for (const session of after.sessions) {
    const previous = prior.get(session.hash);
    if (!previous || previous.userId !== session.userId || previous.expires !== session.expires) upsert.run(session.hash, session.userId, session.expires);
  }
}

const vehicleKey = (vehicle: Vehicle) => JSON.stringify([vehicle.make, vehicle.model, vehicle.year, vehicle.engine, vehicle.registration,
  vehicle.vin, vehicle.customer, vehicle.specifications, vehicle.repairTimes ?? null, vehicle.repairTimesSource ?? null,
  vehicle.repairTimesUpdatedAt ?? null, vehicle.createdAt, vehicle.updatedAt, vehicle.createdBy]);

function writeVehicles(db: DatabaseSync, before: Store, after: Store) {
  removeMissing(db, "vehicles", before.vehicles, after.vehicles);
  const upsert = db.prepare(`INSERT INTO vehicles (id, make, model, year, engine, registration, vin, customer, specifications,
      repair_times, repair_times_source, repair_times_updated_at, created_at, updated_at, created_by, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET make = excluded.make, model = excluded.model, year = excluded.year, engine = excluded.engine,
      registration = excluded.registration, vin = excluded.vin, customer = excluded.customer, specifications = excluded.specifications,
      repair_times = excluded.repair_times, repair_times_source = excluded.repair_times_source,
      repair_times_updated_at = excluded.repair_times_updated_at, created_at = excluded.created_at, updated_at = excluded.updated_at,
      created_by = excluded.created_by, sort = excluded.sort`);
  const move = db.prepare("UPDATE vehicles SET sort = ? WHERE id = ?");
  const prior = new Map(before.vehicles.map(vehicle => [vehicle.id, vehicle]));
  const priorSort = sortValues(before.vehicles);
  const nextSort = sortValues(after.vehicles);
  for (const vehicle of after.vehicles) {
    const previous = prior.get(vehicle.id);
    const sort = nextSort.get(vehicle.id) ?? 0;
    if (!previous || vehicleKey(previous) !== vehicleKey(vehicle)) {
      upsert.run(vehicle.id, vehicle.make, vehicle.model, vehicle.year, vehicle.engine, vehicle.registration, vehicle.vin,
        vehicle.customer, vehicle.specifications, vehicle.repairTimes ? JSON.stringify(vehicle.repairTimes) : null,
        vehicle.repairTimesSource ?? null, vehicle.repairTimesUpdatedAt ?? null,
        vehicle.createdAt, vehicle.updatedAt, vehicle.createdBy, sort);
    } else if (priorSort.get(vehicle.id) !== sort) move.run(sort, vehicle.id);
  }
}

const recordKey = (record: WorkshopRecord) => JSON.stringify([record.kind, record.title, record.vehicleId, record.category, record.content,
  record.date, record.mileage, record.repairTimeMinutes, record.createdAt, record.updatedAt, record.createdBy]);

function writeRecords(db: DatabaseSync, before: Store, after: Store) {
  removeMissing(db, "records", before.records, after.records);
  const upsert = db.prepare(`INSERT INTO records (id, kind, title, vehicle_id, category, content, date, mileage,
      repair_time_minutes, created_at, updated_at, created_by, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title, vehicle_id = excluded.vehicle_id,
      category = excluded.category, content = excluded.content, date = excluded.date, mileage = excluded.mileage,
      repair_time_minutes = excluded.repair_time_minutes, created_at = excluded.created_at, updated_at = excluded.updated_at,
      created_by = excluded.created_by, sort = excluded.sort`);
  const move = db.prepare("UPDATE records SET sort = ? WHERE id = ?");
  const prior = new Map(before.records.map(record => [record.id, record]));
  const priorSort = sortValues(before.records);
  const nextSort = sortValues(after.records);
  for (const record of after.records) {
    const previous = prior.get(record.id);
    const sort = nextSort.get(record.id) ?? 0;
    if (!previous || recordKey(previous) !== recordKey(record)) {
      upsert.run(record.id, record.kind, record.title, record.vehicleId, record.category, record.content, record.date,
        record.mileage, record.repairTimeMinutes, record.createdAt, record.updatedAt, record.createdBy, sort);
    } else if (priorSort.get(record.id) !== sort) move.run(sort, record.id);
  }
}

const attachmentKey = (attachment: Attachment) => JSON.stringify([attachment.recordId, attachment.name, attachment.type,
  attachment.size, attachment.createdAt, attachment.createdBy]);

function writeAttachments(db: DatabaseSync, before: Store, after: Store) {
  removeMissing(db, "attachments", before.attachments, after.attachments);
  const upsert = db.prepare(`INSERT INTO attachments (id, record_id, name, type, size, created_at, created_by, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET record_id = excluded.record_id, name = excluded.name, type = excluded.type,
      size = excluded.size, created_at = excluded.created_at, created_by = excluded.created_by, sort = excluded.sort`);
  const move = db.prepare("UPDATE attachments SET sort = ? WHERE id = ?");
  const prior = new Map(before.attachments.map(attachment => [attachment.id, attachment]));
  const priorSort = sortValues(before.attachments);
  const nextSort = sortValues(after.attachments);
  for (const attachment of after.attachments) {
    const previous = prior.get(attachment.id);
    const sort = nextSort.get(attachment.id) ?? 0;
    if (!previous || attachmentKey(previous) !== attachmentKey(attachment)) {
      upsert.run(attachment.id, attachment.recordId, attachment.name, attachment.type, attachment.size,
        attachment.createdAt, attachment.createdBy, sort);
    } else if (priorSort.get(attachment.id) !== sort) move.run(sort, attachment.id);
  }
}

const activityKey = (entry: Activity) => JSON.stringify([entry.text, entry.actor, entry.at]);

function writeActivity(db: DatabaseSync, before: Store, after: Store) {
  removeMissing(db, "activity", before.activity, after.activity);
  const upsert = db.prepare(`INSERT INTO activity (id, text, actor, at, sort) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET text = excluded.text, actor = excluded.actor, at = excluded.at, sort = excluded.sort`);
  const move = db.prepare("UPDATE activity SET sort = ? WHERE id = ?");
  const prior = new Map(before.activity.map(entry => [entry.id, entry]));
  const priorSort = sortValues(before.activity);
  const nextSort = sortValues(after.activity);
  for (const entry of after.activity) {
    const previous = prior.get(entry.id);
    const sort = nextSort.get(entry.id) ?? 0;
    if (!previous || activityKey(previous) !== activityKey(entry)) upsert.run(entry.id, entry.text, entry.actor, entry.at, sort);
    else if (priorSort.get(entry.id) !== sort) move.run(sort, entry.id);
  }
}

const pdfKey = (sheet: RepairTimePdf) => JSON.stringify([sheet.vehicleId, sheet.name, sheet.size, sheet.createdAt, sheet.createdBy]);

function writeRepairTimePdfs(db: DatabaseSync, before: Store, after: Store) {
  const beforeSheets = before.repairTimePdfs || [];
  const afterSheets = after.repairTimePdfs || [];
  removeMissing(db, "repair_time_pdfs", beforeSheets, afterSheets);
  const upsert = db.prepare(`INSERT INTO repair_time_pdfs (id, vehicle_id, name, size, created_at, created_by, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET vehicle_id = excluded.vehicle_id, name = excluded.name, size = excluded.size,
      created_at = excluded.created_at, created_by = excluded.created_by, sort = excluded.sort`);
  const move = db.prepare("UPDATE repair_time_pdfs SET sort = ? WHERE id = ?");
  const prior = new Map(beforeSheets.map(sheet => [sheet.id, sheet]));
  const priorSort = sortValues(beforeSheets);
  const nextSort = sortValues(afterSheets);
  for (const sheet of afterSheets) {
    const previous = prior.get(sheet.id);
    const sort = nextSort.get(sheet.id) ?? 0;
    if (!previous || pdfKey(previous) !== pdfKey(sheet)) {
      upsert.run(sheet.id, sheet.vehicleId, sheet.name, sheet.size, sheet.createdAt, sheet.createdBy, sort);
    } else if (priorSort.get(sheet.id) !== sort) move.run(sort, sheet.id);
  }
}

function writeRepairTimes(db: DatabaseSync, before: Store, after: Store) {
  const key = (vin: string, operation: string) => `${vin}\u0000${operation}`;
  const collect = (store: Store) => {
    const rows = new Map<string, { vin: string; operation: string; minutes: number }>();
    for (const [vin, entries] of Object.entries(store.repairTimesByVin || {})) {
      for (const entry of entries) rows.set(key(vin, entry.operation), { vin, operation: entry.operation, minutes: entry.minutes });
    }
    return rows;
  };
  const current = collect(before);
  const next = collect(after);
  const remove = db.prepare("DELETE FROM repair_times WHERE vin = ? AND operation = ?");
  for (const [composite, row] of current) if (!next.has(composite)) remove.run(row.vin, row.operation);
  const upsert = db.prepare(`INSERT INTO repair_times (vin, operation, minutes) VALUES (?, ?, ?)
    ON CONFLICT(vin, operation) DO UPDATE SET minutes = excluded.minutes`);
  for (const [composite, row] of next) {
    const previous = current.get(composite);
    if (!previous || previous.minutes !== row.minutes) upsert.run(row.vin, row.operation, row.minutes);
  }
}

function writeStore(db: DatabaseSync, before: Store, after: Store) {
  if (before.name !== after.name) writeMetaValue(db, "name", after.name);
  if (before.vmUrl !== after.vmUrl) writeMetaValue(db, "vmUrl", after.vmUrl);
  if (before.repairTimeMinutes !== after.repairTimeMinutes) writeMetaValue(db, "repairTimeMinutes", String(after.repairTimeMinutes || 0));
  // Users first: sessions reference them, and deleting a user cascades to its sessions.
  writeUsers(db, before, after);
  writeSessions(db, before, after);
  writeVehicles(db, before, after);
  writeRecords(db, before, after);
  writeAttachments(db, before, after);
  writeActivity(db, before, after);
  writeRepairTimePdfs(db, before, after);
  writeRepairTimes(db, before, after);
}

let queue: Promise<unknown> = Promise.resolve();

export function transact<T>(operation: (store: Store) => T | Promise<T>, write = false): Promise<T> {
  const task = queue.then(async () => {
    const db = database();
    db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const store = readStore(db);
      const before = write ? structuredClone(store) : null;
      const result = await operation(store);
      if (before) writeStore(db, before, store);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* The transaction may already be closed. */ }
      throw error;
    }
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
export function filename(value: unknown): string {
  // Keep the browser-supplied name on one line and free of NUL bytes before it reaches a header.
  return text(value, "Filename", 200, true).replace(/[\r\n\t]+/g, " ").split("\u0000").join("");
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
    repairTimeMinutes: db.repairTimeMinutes || 0,
    repairTimePdfs: user?.role === "admin" ? (db.repairTimePdfs || []) : [],
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
