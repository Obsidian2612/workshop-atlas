import { fail } from "./store";
import type { RepairTimeEntry, Vehicle } from "../../src/lib/workshop-types";

const timeoutMs = Number(process.env.GROQ_TIMEOUT_MS) || 90_000;
const maxRows = 100;
const cacheTtl = 30 * 60 * 1000;
const cache = new Map<string, { at: number; data: RepairTimeEntry[] }>();

function vehicleDescription(vehicle: Pick<Vehicle, "vin" | "make" | "model" | "year" | "engine" | "engineModel" | "engineNumber">) {
  return [
    vehicle.vin ? `VIN ${vehicle.vin}` : "",
    vehicle.year,
    vehicle.make,
    vehicle.model,
    vehicle.engineModel ? `engine model ${vehicle.engineModel}` : "",
    vehicle.engineNumber ? `engine number ${vehicle.engineNumber}` : "",
    vehicle.engine ? `engine variant ${vehicle.engine}` : "",
  ].filter(Boolean).join(", ");
}

function promptFor(vehicle: Pick<Vehicle, "vin" | "make" | "model" | "year" | "engine" | "engineModel" | "engineNumber">) {
  return [
    `Find workshop repair times for vehicle ${vehicleDescription(vehicle)}.`,
    "Use your browser_search tool to find real workshop/service-information pages for this exact vehicle.",
    "Prefer manufacturer service pages, OEM workshop manuals, or reputable independent repair-time guides. Do not rely on a related model, year, or generic search-result snippets.",
    "Return only one valid JSON array with no markdown, prose, or code fences:",
    'Format: [{"operation":"Replace front brake pads","minutes":60,"combinedWith":["Replace rear brake pads"],"timeSavingMinutes":15}]',
    `Return at most ${maxRows} repair-time operations. minutes must be a whole number between 0 and 1440.`,
    "Use the fields exactly as shown: operation, minutes, combinedWith, timeSavingMinutes. combinedWith is an array of repair operations the manufacturer/service information explicitly lists as overlapping, done together, or performed by the same labour step. timeSavingMinutes is the estimated labour saved when that overlap is applied.",
    "If you cannot verify a time for this exact vehicle, omit it. If no reliable result is found for this vehicle, return [].",
  ].join("\n");
}

interface GroqRepairReply {
  content: string;
}

async function askGroq(vehicle: Pick<Vehicle, "vin" | "make" | "model" | "year" | "engine" | "engineModel" | "engineNumber">): Promise<string> {
  const key = (process.env.GROQ_API_KEY || "").trim();
  if (!key) fail(503, "GROQ_API_KEY is not configured on the server");
  const model = (process.env.GROQ_MODEL || "openai/gpt-oss-20b").trim();
  if (!["openai/gpt-oss-20b", "openai/gpt-oss-120b"].includes(model)) {
    fail(500, "GROQ_MODEL must be openai/gpt-oss-20b or openai/gpt-oss-120b to use Groq repair-time search.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: promptFor(vehicle) }],
        temperature: 1,
        max_completion_tokens: 4096,
        reasoning_effort: "low",
        stream: false,
        tool_choice: "required",
        tools: [{ type: "browser_search" }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") fail(504, `Groq repair-time search took too long (${Math.round(timeoutMs / 1000)}s). Try again.`);
    fail(502, "Groq could not be reached. Check server network access and GROQ_API_KEY.");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240);
    fail(502, `Groq returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  try {
    const data = await response.json() as GroqRepairReply;
    return data.content || "";
  } catch {
    fail(502, "Groq returned an unreadable response.");
  }
}

function cleanOperation(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

function cleanMinutes(value: unknown) {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : null;
}

function cleanString(value: unknown, max = 200) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function cleanStrings(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map(item => cleanString(item)).filter(Boolean);
}

/** Rows the reader approved in the preview dialog, cleaned again before saving. */
export function cleanRepairTimeRows(input: unknown): RepairTimeEntry[] {
  if (!Array.isArray(input)) return [];
  const rows = new Map<string, RepairTimeEntry>();
  for (const candidate of input) {
    if (rows.size >= maxRows) break;
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as Record<string, unknown>;
    const operation = cleanOperation(row.operation);
    const minutes = cleanMinutes(row.minutes);
    if (!operation || minutes === null) continue;
    // The first row for an operation wins, so a later duplicate cannot drop the
    // overlap notes the reader already saw in the preview.
    if (rows.has(operation.toLowerCase())) continue;
    rows.set(operation.toLowerCase(), {
      operation,
      minutes,
      source: "provider",
      combinedWith: cleanStrings(row.combinedWith),
      timeSavingMinutes: cleanMinutes(row.timeSavingMinutes) ?? 0,
    });
  }
  return [...rows.values()];
}

/** Add or replace repair times by operation name, keeping the vehicle's other rows. */
export function mergeRepairTimes(existing: RepairTimeEntry[], incoming: RepairTimeEntry[]): RepairTimeEntry[] {
  const merged = new Map(existing.map(entry => [entry.operation.toLowerCase(), entry]));
  for (const entry of incoming) merged.set(entry.operation.toLowerCase(), entry);
  return [...merged.values()].sort((a, b) => a.operation.localeCompare(b.operation));
}

function parseRepairTimes(reply: string): RepairTimeEntry[] {
  const rows: RepairTimeEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of JSON.parse(reply) as unknown[]) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as Record<string, unknown>;
    const operation = cleanOperation(row.operation);
    const minutes = cleanMinutes(row.minutes);
    if (!operation || minutes === null) continue;
    const key = `${operation}|${minutes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      operation,
      minutes,
      source: "provider" as const,
      combinedWith: cleanStrings(row.combinedWith),
      timeSavingMinutes: cleanMinutes(row.timeSavingMinutes) ?? 0,
    });
    if (rows.length >= maxRows) break;
  }
  return rows;
}

export async function searchRepairTimes(vehicle: Pick<Vehicle, "vin" | "make" | "model" | "year" | "engine" | "engineModel" | "engineNumber">): Promise<{ operations: RepairTimeEntry[] }> {
  const key = [process.env.GROQ_MODEL || "openai/gpt-oss-20b", vehicle.vin, vehicle.make, vehicle.model, vehicle.year, vehicle.engine, vehicle.engineModel, vehicle.engineNumber].join("|").toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < cacheTtl) return { operations: cached.data };

  const reply = await askGroq(vehicle);
  const rows = parseRepairTimes(reply);
  if (!rows.length) {
    cache.set(key, { at: Date.now(), data: [] });
    return { operations: [] };
  }

  const data = { at: Date.now(), data: rows };
  cache.set(key, data);
  if (cache.size > 60) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 20);
    for (const [entry] of oldest) cache.delete(entry);
  }
  return { operations: rows };
}
