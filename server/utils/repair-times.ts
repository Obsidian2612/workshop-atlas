import { fail, transact } from "./store";
import type { RepairTimeEntry, Vehicle } from "../../src/lib/workshop-types";

const maxRows = 5000;
const maxText = 2_000_000;
const providerTimeout = Number(process.env.REPAIR_API_TIMEOUT_MS) || 5000;

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
