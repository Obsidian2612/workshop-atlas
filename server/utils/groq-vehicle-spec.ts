import { fail } from "./store";
import { cleanTorqueValue, normalizeTorqueUnit } from "./torques";
import type { SpecSheetRow, SpecSheetSection, TorqueSearchSource, TorqueSpec, Vehicle, VehicleSpecSheet } from "../../src/lib/workshop-types";
import { cleanRepairTimeRows } from "./groq-repair-times";

/*
 * The workshop's specification sheets (identification, emissions, capacities,
 * torques, brake dimensions, air conditioning) and repair times are looked up
 * online by Groq.
 * The model answers with one JSON object; everything is cleaned here before it
 * reaches the preview dialog, so a malformed or partial reply never writes junk
 * onto a vehicle.
 */

const timeoutMs = Number(process.env.GROQ_TIMEOUT_MS) || 90_000;
const maxSections = 14;
const maxRows = 160;
const maxTorques = 120;
const cacheTtl = 10 * 60 * 1000;
const cache = new Map<string, { at: number; data: VehicleSpecSheet }>();
const toolNames = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"];
const sectionOrder = [
  "Engine and ignition",
  "Fuel system",
  "Tuning and emissions",
  "Spark plugs",
  "Service checks and adjustments",
  "Lubricants and capacities",
  "Starting and charging",
  "Brake disc and drum dimensions",
  "Air conditioning",
];

interface SpecVehicle {
  vin: string;
  make: string;
  model: string;
  year: string;
  engine: string;
  engineModel: string;
  engineNumber: string;
}

function describe(vehicle: SpecVehicle) {
  return [
    vehicle.vin ? `VIN ${vehicle.vin}` : "",
    vehicle.year,
    vehicle.make,
    vehicle.model,
    vehicle.engineModel ? `engine model ${vehicle.engineModel}` : "",
    vehicle.engine ? `engine ${vehicle.engine}` : "",
    vehicle.engineNumber ? `engine number ${vehicle.engineNumber}` : "",
  ].filter(Boolean).join(", ");
}

function promptFor(vehicle: SpecVehicle) {
  return [
    `Research the full manufacturer workshop specification sheet and standard repair times for this exact vehicle: ${describe(vehicle)}.`,
    "Use your browser_search tool to find real service-information pages, OEM workshop manuals or a reputable workshop data source that identifies the matching make, model, year and engine.",
    "Never copy values from a different engine or generation and never invent a value. Omit any field you cannot verify.",
    "Return only one valid JSON object, with no markdown, prose or code fences:",
    '{"identification":{"make":"","model":"","year":"","engine":"","engineModel":"","engineNumber":"","vin":""},"sections":[{"title":"Engine and ignition","rows":[{"label":"Capacity","value":"1598 cc"}]}],"torques":[{"fastener":"Cylinder head","stage":"1","value":25,"unit":"Nm"}],"repairTimes":[{"operation":"Replace front brake pads","minutes":60,"combinedWith":["Replace rear brake pads"],"timeSavingMinutes":15}],"sources":[{"title":"Source page title","url":"https://...","snippet":"Short exact supporting text"}]}',
    `Cover every section the source documents, using these titles in this order: ${sectionOrder.map(title => `"${title}"`).join(", ")}.`,
    'Each row is one labelled value, for example {"label":"Engine oil grade","value":"SAE 5W-30"} or {"label":"Firing order","value":"1-3-4-2"}. Keep labels short, copy values exactly with their units, and keep at most 12 rows per section.',
    `torques: every engine and chassis tightening torque, one row per fastener and stage. unit must be one of "Nm", "lbf·ft", "lbf·in" or "kgf·m" — convert anything else. Put front/rear or the component location in the fastener name where the source distinguishes them. Return at most ${maxTorques} torque rows.`,
    "repairTimes: standard workshop labour times for this exact vehicle from the same sources, one row per operation. minutes must be a whole number between 0 and 1440. combinedWith lists the operations the source says overlap or are done in the same labour step, and timeSavingMinutes is the labour saved when they are done together. Use short operation names, return at most 60 rows, and an empty array when the source gives no times.",
    "sources: the pages you actually read, with direct URLs (never search-result URLs) and a short exact supporting snippet. An empty array is fine when nothing could be verified.",
  ].join("\n");
}

/** Lift the first complete JSON object out of a reply that may wrap it in prose or a code fence. */
export function parseSpecObject(reply: string): Record<string, unknown> | null {
  const body = reply.replace(/```(?:json)?/gi, "").trim();
  for (let start = 0; start < body.length; start++) {
    if (body[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < body.length; end++) {
      const char = body[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          const value: unknown = JSON.parse(body.slice(start, end + 1));
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const object = value as Record<string, unknown>;
            if ("sections" in object || "identification" in object) return object;
          }
        } catch { /* Try the next opening brace; this one was probably prose. */ }
        break;
      }
    }
  }
  return null;
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

/** Clean reviewed rows before they are merged onto a vehicle. */
export function cleanSpecSections(input: unknown): SpecSheetSection[] {
  if (!Array.isArray(input)) fail(400, "Send the specification sheet as a list of sections");
  const sections: SpecSheetSection[] = [];
  let rowsUsed = 0;
  for (const item of input) {
    if (sections.length >= maxSections) break;
    if (!item || typeof item !== "object") fail(400, "Invalid specification section");
    const raw = item as Record<string, unknown>;
    const title = cleanText(raw.title, 80);
    if (title.length < 2) fail(400, "Each specification section needs a title");
    if (!Array.isArray(raw.rows)) fail(400, `The section “${title}” has no rows`);
    const rows: SpecSheetRow[] = [];
    for (const entry of raw.rows) {
      if (rowsUsed >= maxRows) break;
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const label = cleanText(row.label, 80);
      const value = cleanText(row.value, 300);
      if (label.length < 1 || !value) continue;
      const note = cleanText(row.note, 200);
      rows.push(note ? { label, value, note } : { label, value });
      rowsUsed += 1;
    }
    if (rows.length) sections.push({ title, rows });
  }
  // An empty list is allowed so a times-only save leaves the specification text alone.
  return sections;
}

function cleanTorques(input: unknown): TorqueSpec[] {
  if (!Array.isArray(input)) return [];
  const rows = new Map<string, TorqueSpec>();
  for (const item of input) {
    if (rows.size >= maxTorques) break;
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const fastener = cleanText(raw.fastener, 200);
    const value = cleanTorqueValue(raw.value ?? raw.torque);
    const unit = normalizeTorqueUnit(raw.unit);
    if (fastener.length < 2 || value === null || !unit) continue;
    const stage = cleanText(raw.stage, 40);
    const key = `${fastener.toLowerCase()}\u0000${stage.toLowerCase()}`;
    rows.set(key, { fastener, stage, value, unit });
  }
  return [...rows.values()];
}

function cleanSources(...values: unknown[]): TorqueSearchSource[] {
  const sources = new Map<string, TorqueSearchSource>();
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const raw = item as Record<string, unknown>;
      const url = safeUrl(raw.url);
      if (!url || sources.has(url)) continue;
      sources.set(url, {
        title: cleanText(raw.title, 200) || new URL(url).hostname,
        url,
        snippet: cleanText(raw.snippet, 400),
      });
      if (sources.size >= 8) return [...sources.values()];
    }
  }
  return [...sources.values()];
}

function cleanSheet(reply: string, vehicle: SpecVehicle): VehicleSpecSheet | null {
  const parsed = parseSpecObject(reply);
  if (!parsed) return null;
  const identification = parsed.identification && typeof parsed.identification === "object"
    ? parsed.identification as Record<string, unknown>
    : {};
  const sections: SpecSheetSection[] = [];
  let rowsUsed = 0;
  if (Array.isArray(parsed.sections)) {
    for (const item of parsed.sections) {
      if (sections.length >= maxSections) break;
      if (!item || typeof item !== "object") continue;
      const raw = item as Record<string, unknown>;
      const title = cleanText(raw.title, 80);
      if (!title || !Array.isArray(raw.rows)) continue;
      const rows: SpecSheetRow[] = [];
      const seen = new Set<string>();
      for (const entry of raw.rows) {
        if (rowsUsed >= maxRows) break;
        if (!entry || typeof entry !== "object") continue;
        const row = entry as Record<string, unknown>;
        const label = cleanText(row.label, 80);
        const value = cleanText(row.value, 300);
        if (!label || !value || seen.has(label.toLowerCase())) continue;
        seen.add(label.toLowerCase());
        const note = cleanText(row.note, 200);
        rows.push(note ? { label, value, note } : { label, value });
        rowsUsed += 1;
      }
      if (rows.length) sections.push({ title, rows });
    }
  }
  // A reply that only repeats the identification is not a worthwhile sheet to save.
  if (!sections.length) return null;
  return {
    identification: {
      make: cleanText(identification.make, 80) || vehicle.make,
      model: cleanText(identification.model, 100) || vehicle.model,
      year: cleanText(identification.year, 20) || vehicle.year,
      engine: cleanText(identification.engine, 100),
      engineModel: cleanText(identification.engineModel, 100),
      engineNumber: cleanText(identification.engineNumber, 60),
      vin: cleanText(identification.vin, 30).toUpperCase(),
    },
    sections,
    torques: cleanTorques(parsed.torques),
    repairTimes: cleanRepairTimeRows(parsed.repairTimes ?? parsed.operations),
    sources: cleanSources(parsed.sources, parsed.results),
  };
}

export async function searchVehicleSpec(vehicle: SpecVehicle): Promise<VehicleSpecSheet> {
  const key = [process.env.GROQ_MODEL || "openai/gpt-oss-20b", vehicle.vin, vehicle.make, vehicle.model, vehicle.year, vehicle.engine, vehicle.engineModel, vehicle.engineNumber]
    .join("|").toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < cacheTtl) return cached.data;

  const reply = await askGroq(vehicle);
  const sheet = cleanSheet(reply, vehicle);
  if (!sheet) fail(502, "Groq did not return a usable specification sheet. Add the engine model or year to the vehicle and try again.");

  cache.set(key, { at: Date.now(), data: sheet });
  if (cache.size > 40) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 15);
    for (const [entry] of oldest) cache.delete(entry);
  }
  return sheet;
}

async function askGroq(vehicle: SpecVehicle): Promise<string> {
  const key = (process.env.GROQ_API_KEY || "").trim();
  if (!key) fail(503, "GROQ_API_KEY is not configured on the server");
  const model = (process.env.GROQ_MODEL || "openai/gpt-oss-20b").trim();
  if (!toolNames.includes(model)) fail(500, "GROQ_MODEL must be openai/gpt-oss-20b or openai/gpt-oss-120b to use Groq specification search.");

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
        // The sheet now carries sections, torques and repair times in one reply.
        max_completion_tokens: 12288,
        reasoning_effort: "low",
        stream: false,
        tool_choice: "required",
        tools: [{ type: "browser_search" }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") fail(504, `Groq specification search took too long (${Math.round(timeoutMs / 1000)}s). Try again.`);
    fail(502, "Groq could not be reached. Check the server's network access and GROQ_API_KEY.");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240);
    fail(502, `Groq returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  try {
    const data = await response.json() as { choices?: { message?: { content?: string | null } }[] };
    return data.choices?.[0]?.message?.content || "";
  } catch {
    fail(502, "Groq returned an unreadable response.");
  }
}

/** The text written to the vehicle's specifications card. */
export function formatSpecSheet(vehicle: Pick<Vehicle, "make" | "model" | "year">, sections: SpecSheetSection[]) {
  const lines = [`${vehicle.make} ${vehicle.model}${vehicle.year ? ` · ${vehicle.year}` : ""}`.trim(), ""];
  for (const section of sections) {
    lines.push(section.title.toUpperCase());
    for (const row of section.rows) lines.push(`${row.label}: ${row.value}${row.note ? ` (${row.note})` : ""}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}
