import { dataDir, fail, text, transact } from "./store";
import type { Store } from "./store";
import type { RepairTimeEntry } from "../../src/lib/workshop-types";

const maxText = 2_000_000;
const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS) || 20000;

export interface GeminiRepairRow {
  vin: string;
  operation: string;
  minutes: number;
}

export function parseGeminiImportFormat(format: unknown, data: unknown): GeminiRepairRow[] {
  if (typeof data !== "string" || !data.trim()) fail(400, "Paste repair-time data first");
  if (data.length > maxText) fail(400, "Repair-time data is too large (2 MB maximum)");
  const normalized = data
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n")
    .trim();
  const lines = normalized.split("\n");
  if (!lines.length) fail(400, "No repair-time rows were found");
  let rows: { operation: string; minutes: number; vin: string }[] = [];
  const invalidChar = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
  const hasInvalidChar = (value: string) => invalidChar.test(value);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (hasInvalidChar(trimmed)) continue;
    const match = trimmed.match(/^(.+?)\s*\[minutes=([^]\n]+)\]$/);
    if (!match) fail(400, `Unrecognized repair-time row: ${trimmed.slice(0, 80)}`);
    const vin = text(match[1], "VIN", 30, true);
    const operation = text(match[2], "Operation", 200, true);
    const minutesText = text(match[3], "Minutes", 40, true);
    const minutes = parseFloat(minutesText.replace(",", "."));
    const parsed = Number.isFinite(minutes) ? Math.round(minutes * 60) : null;
    if (!operation || parsed === null) fail(400, `Unrecognized repair-time row: ${trimmed.slice(0, 80)}`);
    if (parsed < 0 || parsed > 1440) fail(400, `Minutes out of range on row: ${trimmed.slice(0, 80)}`);
    rows.push({ operation, minutes: parsed, vin });
  }
  if (!rows.length) fail(400, "No valid repair-time rows were found");
  return rows;
}

export async function applyGeminiRows(rows: GeminiRepairRow[]) {
  const now = new Date().toISOString();
  return transact(db => {
    const dataset = { ...(db.repairTimesByVin || {}) };
    for (const row of rows) {
      const key = row.vin.toUpperCase();
      const list = dataset[key] ? [...dataset[key]] : [];
      const index = list.findIndex(existing => existing.operation.toLowerCase() === row.operation.toLowerCase());
      if (index >= 0) list[index] = { operation: row.operation, minutes: row.minutes };
      else list.push({ operation: row.operation, minutes: row.minutes });
      dataset[key] = list;
    }
    db.repairTimesByVin = dataset;
    let vehicles = 0;
    for (const vehicle of db.vehicles) {
      const key = vehicle.vin ? vehicle.vin.toUpperCase() : "";
      const list = key ? dataset[key] : undefined;
      if (!list || !list.length) continue;
      vehicle.repairTimes = list.map(entry => ({ operation: entry.operation, minutes: entry.minutes, source: "gemini" as const })) as unknown as RepairTimeEntry[];
      vehicle.repairTimesSource = "gemini";
      vehicle.repairTimesUpdatedAt = now;
      vehicles++;
    }
    return { entries: rows.length, vins: Object.keys(dataset).length, vehicles };
  }, true);
}

export async function fetchGeminiRepairTimes(vin: string, make?: string, model?: string, year?: string) {
  if (!process.env.GEMINI_API_KEY) return [];
  const url = `https://generativelanguage.googleapis.com/v1/models/${model || "gemini-2.5-flash"}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const payload = {
    contents: [{
      parts: [{
        text: `Repair times for vehicle VIN ${vin}${make ? " make " + make : ""}${model ? " model " + model : ""}${year ? " year " + year : ""}. Return a JSON array of { operation, minutes } objects for this vehicle.`
      }]
    }]
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    let lines = "";
    for (const candidate of data.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        lines += part.text || "";
      }
    }
    return parseGeminiImportFormat("import", lines);
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    console.warn("Gemini repair-time fetch failed:", (error as Error).message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
