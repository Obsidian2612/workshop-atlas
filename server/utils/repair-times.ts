import { fail, transact } from "./store";
import type { RepairTimeEntry, Vehicle } from "../../src/lib/workshop-types";

const maxRows = 5000;
const maxText = 2_000_000;
const providerTimeout = Number(process.env.REPAIR_API_TIMEOUT_MS) || 5000;

/**
 * Apply the operations parsed from an uploaded sheet to one vehicle.
 * When the vehicle has a VIN the same entry keys are also written to the global
 * licensed dataset, so future vehicle lookups and other refresh actions can use them.
 */
export async function applySheetRepairTimes(vehicleId: string, operations: { operation: string; minutes: number }[]) {
  const now = new Date().toISOString();
  return transact(db => {
    const vehicle = db.vehicles.find(v => v.id === vehicleId);
    if (!vehicle) return null;
    const merged = new Map<string, RepairTimeEntry>();
    for (const entry of vehicle.repairTimes || []) merged.set(entry.operation.toLowerCase(), entry);
    for (const entry of operations) {
      const key = entry.operation.toLowerCase();
      // A time the reader typed in by hand stays put; a sheet must not replace it.
      if (merged.get(key)?.source === "manual") continue;
      merged.set(key, { operation: entry.operation, minutes: entry.minutes, source: "imported" as const });
    }
    vehicle.repairTimes = [...merged.values()].sort((a, b) => a.operation.localeCompare(b.operation));
    const sources = new Set(vehicle.repairTimes.map(e => e.source));
    vehicle.repairTimesSource = sources.has("provider") ? "provider + imported" : Array.from(sources).join(" + ") || "imported";
    vehicle.repairTimesUpdatedAt = now;
    if (vehicle.vin) {
      const key = vehicle.vin.toUpperCase();
      const dataset = { ...(db.repairTimesByVin || {}) };
      const list = [...(dataset[key] || [])];
      const index = new Map(list.map((entry, i) => [entry.operation.toLowerCase(), i]));
      for (const entry of operations) {
        const existing = index.get(entry.operation.toLowerCase());
        if (existing === undefined) { index.set(entry.operation.toLowerCase(), list.length); list.push({ operation: entry.operation, minutes: entry.minutes }); }
        else list[existing] = { operation: entry.operation, minutes: entry.minutes };
      }
      dataset[key] = list;
      db.repairTimesByVin = dataset;
    }
    return { operationCount: operations.length, vehicle };
  }, true);
}

export type RepairTimeRow = { vin: string; operation: string; minutes: number };

function cleanOperation(value: unknown) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.slice(0, 200);
}
function cleanMinutes(value: unknown) {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : null;
}
function cleanVin(value: unknown) {
  const vin = typeof value === "string" ? value.trim().toUpperCase() : "";
  return vin.slice(0, 30);
}

function splitCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (char !== "\r") cell += char;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function parseCsv(text: string): RepairTimeRow[] {
  const rows = splitCsv(text).filter(cells => cells.some(cell => cell.trim() !== ""));
  if (!rows.length) return [];
  const header = rows[0].map(cell => cell.trim().toLowerCase());
  const hasHeader = header.includes("vin") && header.includes("minutes");
  const vinIndex = hasHeader ? header.indexOf("vin") : 0;
  const operationIndex = hasHeader ? Math.max(header.indexOf("operation"), header.indexOf("name"), header.indexOf("description")) : 1;
  const minutesIndex = hasHeader ? header.indexOf("minutes") : 2;
  if (operationIndex < 0) fail(400, "CSV needs an operation column (vin, operation, minutes)");
  return rows.slice(hasHeader ? 1 : 0).flatMap(cells => {
    const vin = cleanVin(cells[vinIndex]);
    const operation = cleanOperation(cells[operationIndex]);
    const minutes = cleanMinutes(cells[minutesIndex]);
    return vin && operation && minutes !== null ? [{ vin, operation, minutes }] : [];
  });
}

function parseJson(text: string): RepairTimeRow[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail(400, "The pasted JSON could not be parsed"); }
  let list: unknown[] = [];
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.entries)) list = record.entries;
    else {
      for (const [vin, entries] of Object.entries(record)) {
        if (Array.isArray(entries)) list.push(...entries.map(entry => ({ vin, ...(entry as object) })));
      }
    }
  }
  return list.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const vin = cleanVin(row.vin ?? row.VIN);
    const operation = cleanOperation(row.operation ?? row.name ?? row.description);
    const minutes = cleanMinutes(row.minutes ?? row.min ?? row.time);
    return vin && operation && minutes !== null ? [{ vin, operation, minutes }] : [];
  });
}

export function parseRepairTimeImport(format: unknown, data: unknown): RepairTimeRow[] {
  if (typeof data !== "string" || !data.trim()) fail(400, "Paste or upload repair-time data first");
  if (data.length > maxText) fail(400, "Repair-time data is too large (2 MB maximum)");
  if (format !== "csv" && format !== "json") fail(400, "Choose CSV or JSON format");
  const rows = format === "csv" ? parseCsv(data) : parseJson(data);
  if (!rows.length) fail(400, "No valid repair-time rows were found");
  if (rows.length > maxRows) fail(400, `Import at most ${maxRows} rows at a time`);
  return rows;
}

export async function importRepairTimes(rows: RepairTimeRow[]) {
  const now = new Date().toISOString();
  return transact(db => {
    const dataset = { ...(db.repairTimesByVin || {}) };
    for (const row of rows) {
      const key = row.vin.toUpperCase();
      const list = dataset[key] ? [...dataset[key]] : [];
      const entry = { operation: row.operation, minutes: row.minutes };
      const index = list.findIndex(existing => existing.operation.toLowerCase() === row.operation.toLowerCase());
      if (index >= 0) list[index] = entry;
      else list.push(entry);
      dataset[key] = list;
    }
    db.repairTimesByVin = dataset;
    let vehicles = 0;
    for (const vehicle of db.vehicles) {
      const list = vehicle.vin ? dataset[vehicle.vin.toUpperCase()] : undefined;
      if (!list || !list.length) continue;
      vehicle.repairTimes = list.map(entry => ({ ...entry, source: "imported" as const }));
      vehicle.repairTimesSource = "imported";
      vehicle.repairTimesUpdatedAt = now;
      vehicles++;
    }
    return { entries: rows.length, vins: Object.keys(dataset).length, vehicles };
  }, true);
}

function mergeEntries(imported: RepairTimeEntry[], provider: RepairTimeEntry[]) {
  const merged = new Map<string, RepairTimeEntry>();
  for (const entry of [...imported, ...provider]) merged.set(entry.operation.toLowerCase(), entry);
  return [...merged.values()].sort((a, b) => a.operation.localeCompare(b.operation));
}

function providerRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["operations", "repairTimes", "data", "results"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

async function fetchProvider(vehicle: Pick<Vehicle, "vin" | "make" | "model" | "year">): Promise<RepairTimeEntry[]> {
  const endpoint = process.env.REPAIR_API_URL;
  if (!endpoint || !vehicle.vin) return [];
  let target: URL;
  try { target = new URL(endpoint); } catch {
    console.warn("REPAIR_API_URL is not a valid URL; skipping provider lookup");
    return [];
  }
  target.searchParams.set("vin", vehicle.vin);
  if (vehicle.make) target.searchParams.set("make", vehicle.make);
  if (vehicle.model) target.searchParams.set("model", vehicle.model);
  if (vehicle.year) target.searchParams.set("year", vehicle.year);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), providerTimeout);
  try {
    const response = await fetch(target, {
      headers: { Accept: "application/json", ...(process.env.REPAIR_API_KEY ? { Authorization: `Bearer ${process.env.REPAIR_API_KEY}` } : {}) },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`Repair-time provider returned ${response.status}`);
      return [];
    }
    return providerRows(await response.json()).flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const operation = cleanOperation(row.operation ?? row.name ?? row.description);
      const minutes = cleanMinutes(row.minutes ?? row.min ?? row.time);
      return operation && minutes !== null ? [{ operation, minutes, source: "provider" as const }] : [];
    });
  } catch (error) {
    console.warn("Repair-time provider lookup failed", error);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Keep the reader's own repair times sorted by name, as the other sources are. */
export function sortRepairTimes(entries: RepairTimeEntry[]) {
  return [...entries].sort((a, b) => a.operation.localeCompare(b.operation));
}

function cleanScope(value: unknown) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.slice(0, 40);
}

function cleanNotes(value: unknown) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.slice(0, 500);
}

/** A capture date is a plain day, so a scheduled job is comparable to today. */
function cleanCapturedAt(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "";
  const day = value.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, "Captured date must be written as YYYY-MM-DD");
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) fail(400, "That captured date is not a real date");
  return day;
}

function cleanIncludes(value: unknown) {
  if (!Array.isArray(value)) return [];
  const steps: RepairTimeEntry["includes"] = [];
  for (const candidate of value.slice(0, 40)) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as Record<string, unknown>;
    const label = cleanOperation(row.label);
    if (!label) continue;
    const minutes = cleanMinutes(row.minutes) ?? 0;
    steps.push({ label, scope: cleanScope(row.scope), minutes });
  }
  return steps;
}

/** Validate one hand-entered repair time before it is stored on a vehicle. */
export function cleanManualRepairTime(input: unknown): Omit<RepairTimeEntry, "source"> {
  if (!input || typeof input !== "object") fail(400, "A repair time is required");
  const row = input as Record<string, unknown>;
  const operation = cleanOperation(row.operation);
  if (!operation) fail(400, "Give the repair time an operation name");
  const minutes = cleanMinutes(row.minutes);
  if (minutes === null) fail(400, "Repair time must be a whole number of minutes between 0 and 1440");
  const includes = cleanIncludes(row.includes);
  // A bundled step cannot push the operation past a single working day either.
  const included = includes?.reduce((sum, step) => sum + step.minutes, 0) ?? 0;
  if (included > 1440) fail(400, "The included steps add up to more than 1440 minutes");
  return {
    operation,
    minutes,
    ...(cleanScope(row.scope) ? { scope: cleanScope(row.scope) } : {}),
    ...(includes?.length ? { includes } : {}),
    ...(cleanCapturedAt(row.capturedAt) ? { capturedAt: cleanCapturedAt(row.capturedAt) } : {}),
    ...(cleanNotes(row.notes) ? { notes: cleanNotes(row.notes) } : {}),
  };
}

const manualCsvHeader = "operation,minutes,scope,captured at,notes,includes";

/**
 * Read hand-entered repair times from CSV. The first line must name the columns,
 * so a file cannot be silently read with the wrong layout. The includes column is
 * optional; steps in it are separated by ";" as "label | code | minutes".
 */
export function parseManualRepairTimeCsv(text: string) {
  const rows = splitCsv(text).filter(cells => cells.some(cell => cell.trim() !== ""));
  if (!rows.length) fail(400, `Paste CSV starting with a header line: ${manualCsvHeader}`);
  const header = rows[0].map(cell => cell.trim().toLowerCase().replace(/\s+/g, ""));
  if (!header.includes("operation") || !header.includes("minutes")) {
    fail(400, `The first CSV line must name the columns and include operation and minutes, for example: ${manualCsvHeader}`);
  }
  const column = (cells: string[], name: string) => {
    const at = header.indexOf(name);
    return at < 0 ? "" : cells[at] ?? "";
  };
  const entries = rows.slice(1).flatMap(cells => {
    const operation = column(cells, "operation").trim();
    // A blank operation is a spacer row rather than an error.
    if (!operation) return [];
    const includes = column(cells, "includes").split(";").flatMap(part => {
      const [label, scope, minutes] = part.split("|").map(piece => piece.trim());
      return label ? [{ label, scope, minutes }] : [];
    });
    const capturedAt = column(cells, "capturedat") || column(cells, "captured") || column(cells, "date");
    const minutes = column(cells, "minutes").trim();
    if (minutes === "") fail(400, `Row "${operation}" has no minutes`);
    return [cleanManualRepairTime({ operation, minutes, scope: column(cells, "scope"), capturedAt, notes: column(cells, "notes"), includes })];
  });
  if (!entries.length) fail(400, "No repair-time rows were found under the header line");
  if (entries.length > 500) fail(400, "Add at most 500 repair times per CSV import");
  return entries;
}

/** Write hand-entered rows into the vehicle in one transaction. */
async function writeManualRepairTimes(vehicleId: string, entries: Omit<RepairTimeEntry, "source">[], originalOperation = "") {
  const now = new Date().toISOString();
  return transact(db => {
    const vehicle = db.vehicles.find(item => item.id === vehicleId);
    if (!vehicle) return null;
    const merged = new Map((vehicle.repairTimes || []).map(item => [item.operation.toLowerCase(), item]));
    if (originalOperation) merged.delete(originalOperation.toLowerCase());
    for (const entry of entries) merged.set(entry.operation.toLowerCase(), { ...entry, source: "manual" as const });
    vehicle.repairTimes = sortRepairTimes([...merged.values()]);
    vehicle.repairTimesSource = [...new Set(vehicle.repairTimes.map(item => item.source))].join(" + ");
    vehicle.repairTimesUpdatedAt = now;
    return vehicle;
  }, true);
}

/**
 * Add or replace a hand-entered repair time on one vehicle. `originalOperation`
 * renames an existing row instead of leaving the old name behind.
 */
export async function saveManualRepairTime(vehicleId: string, entry: Omit<RepairTimeEntry, "source">, originalOperation = "") {
  return writeManualRepairTimes(vehicleId, [entry], originalOperation);
}

/** Add many hand-entered repair times at once, as read from CSV. */
export async function saveManualRepairTimes(vehicleId: string, entries: Omit<RepairTimeEntry, "source">[]) {
  return writeManualRepairTimes(vehicleId, entries);
}

/** Only a hand-entered row can be deleted here; imported and AI rows stay put. */
export async function removeManualRepairTime(vehicleId: string, operation: string) {
  const now = new Date().toISOString();
  return transact(db => {
    const vehicle = db.vehicles.find(item => item.id === vehicleId);
    if (!vehicle) return null;
    const key = operation.toLowerCase();
    const target = (vehicle.repairTimes || []).find(item => item.operation.toLowerCase() === key);
    if (!target) return { removed: false };
    if (target.source !== "manual") fail(403, "Only repair times you entered by hand can be deleted here");
    vehicle.repairTimes = (vehicle.repairTimes || []).filter(item => item.operation.toLowerCase() !== key);
    vehicle.repairTimesSource = [...new Set(vehicle.repairTimes.map(item => item.source))].join(" + ") || "none";
    vehicle.repairTimesUpdatedAt = now;
    return { removed: true };
  }, true);
}

export async function refreshVehicleRepairTimes(vehicleId: string, force = false) {
  const snapshot = await transact(db => {
    const vehicle = db.vehicles.find(item => item.id === vehicleId);
    return vehicle ? { id: vehicle.id, vin: vehicle.vin, make: vehicle.make, model: vehicle.model, year: vehicle.year, updatedAt: vehicle.repairTimesUpdatedAt } : undefined;
  });
  if (!snapshot || !snapshot.vin) return null;
  const vin = snapshot.vin;
  if (!force && snapshot.updatedAt) {
    const age = Date.now() - Date.parse(snapshot.updatedAt);
    if (Number.isFinite(age) && age < 24 * 60 * 60 * 1000) return null;
  }
  const imported = await transact(db => (db.repairTimesByVin?.[vin.toUpperCase()] || []).map(entry => ({ ...entry, source: "imported" as const })));
  const provider = await fetchProvider(snapshot);
  const entries = mergeEntries(imported, provider);
  const now = new Date().toISOString();
  return transact(db => {
    const vehicle = db.vehicles.find(item => item.id === vehicleId);
    if (!vehicle) return null;
    vehicle.repairTimes = entries;
    vehicle.repairTimesUpdatedAt = now;
    vehicle.repairTimesSource = [...new Set(entries.map(entry => entry.source))].join(" + ") || "none";
    return vehicle;
  }, true);
}
