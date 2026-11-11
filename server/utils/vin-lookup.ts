import { fail } from "./store";

/*
 * VIN decoding for the vehicle editor.
 *
 * The public NHTSA vPIC decoder answers the identity fields it can prove
 * (make, model, model year, engine size) without a key, and Groq fills the gaps
 * a workshop writes on a job card (engine / variant, manufacturer engine code).
 * Nothing is written here: the editor only fills fields the reader left empty,
 * so a suggestion never overwrites something a person already recorded.
 */

export type VinField = "make" | "model" | "year" | "engine" | "engineModel";
export const vinFields: VinField[] = ["make", "model", "year", "engine", "engineModel"];

export interface VinLookupResult {
  vin: string;
  fields: Partial<Record<VinField, string>>;
  /** Fields the VIN decoder answered. */
  decoded: VinField[];
  /** Fields the AI suggested on top of the decoder. */
  suggested: VinField[];
  warnings: string[];
}

const vinPattern = /^[A-HJ-NPR-Z0-9]{11,17}$/;
const decoderTimeout = Number(process.env.VIN_TIMEOUT_MS) || 8_000;
const aiTimeout = Number(process.env.VIN_AI_TIMEOUT_MS) || 30_000;
const cacheTtl = 30 * 60 * 1000;
const aiModels = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"];
const cache = new Map<string, { at: number; data: VinLookupResult }>();

export function cleanVin(value: unknown) {
  const vin = typeof value === "string" ? value.replace(/[\s-]+/g, "").toUpperCase() : "";
  if (!vin) fail(400, "Enter the VIN to look up");
  if (vin.length < 11) fail(400, "Enter at least the first 11 characters of the VIN");
  if (!vinPattern.test(vin)) fail(400, "A VIN has up to 17 letters and digits and never uses I, O or Q");
  return vin;
}

function clean(value: unknown, max = 100) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function positiveNumber(value: string) {
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) && number > 0 ? String(Math.round(number * 10) / 10) : "";
}

/** Ask the free NHTSA decoder; a look-up failure is a caveat, never a hard error. */
async function decodeVin(vin: string) {
  const fields: Partial<Record<VinField, string>> = {};
  const warnings: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), decoderTimeout);
  let row: Record<string, string> | undefined;
  try {
    const response = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`,
      { signal: controller.signal },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { Results?: Record<string, string>[] };
    row = data.Results?.[0];
  } catch {
    warnings.push("The free VIN decoder could not be reached, so any details below come from the AI alone.");
  } finally {
    clearTimeout(timer);
  }
  if (!row) return { fields, warnings };

  const make = clean(row.Make, 80);
  const model = clean(row.Model, 100);
  const year = clean(row.ModelYear, 20);
  if (make) fields.make = make;
  if (model && model !== "0") fields.model = model;
  if (/^\d{4}$/.test(year)) fields.year = year;

  const litres = positiveNumber(clean(row.DisplacementL, 20));
  const cylinders = positiveNumber(clean(row.EngineCylinders, 20));
  const fuel = clean(row.FuelTypePrimary, 40).toLowerCase();
  const engine = [litres && `${litres}L`, cylinders && `${cylinders}-cyl`, fuel].filter(Boolean).join(" ");
  if (engine) fields.engine = engine;
  const engineModel = clean(row.EngineModel, 80);
  if (engineModel) fields.engineModel = engineModel;

  // vPIC states what it could not decode as "0 - VIN decoded clean…" or an error code.
  const errors = clean(row.ErrorText, 300);
  if (errors && !/^0\s*-/.test(errors)) warnings.push(`The VIN decoder reported: ${errors}`);
  return { fields, warnings };
}

function promptFor(vin: string, known: Partial<Record<VinField, string>>) {
  const decoded = [known.make, known.model, known.year].filter(Boolean).join(", ");
  return [
    `Decode this vehicle identification number: ${vin}.`,
    decoded ? `The VIN decoder already reports: ${decoded}.` : "",
    "Return only one valid JSON object, with no markdown, prose or code fences:",
    '{"make":"","model":"","year":"","engine":"","engineModel":""}',
    'engine is the engine or variant a workshop writes on the job card, e.g. "1.6 TDI" or "2.0 TSI".',
    'engineModel is the manufacturer\'s engine code, e.g. "CWVA" or "K20C".',
    "Use the VIN's world manufacturer, model-year and plant characters to support your answer.",
    "Leave a field as an empty string when the VIN does not confirm it, and never invent a value. A VIN never contains the stamped engine number, so do not return one.",
  ].filter(Boolean).join("\n");
}

/** Lift the first complete JSON object out of a reply that may wrap it in prose or a code fence. */
export function parseVinObject(reply: string): Record<string, unknown> | null {
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
          if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
        } catch { /* Try the next opening brace; this one was probably prose. */ }
        break;
      }
    }
  }
  return null;
}

async function askGroq(vin: string, known: Partial<Record<VinField, string>>): Promise<Partial<Record<VinField, string>>> {
  const key = (process.env.GROQ_API_KEY || "").trim();
  if (!key) throw new Error("GROQ_API_KEY is not configured on the server, so the AI could not add any details.");
  const model = (process.env.GROQ_MODEL || "openai/gpt-oss-20b").trim();
  if (!aiModels.includes(model)) throw new Error("GROQ_MODEL must be openai/gpt-oss-20b or openai/gpt-oss-120b for VIN lookup.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), aiTimeout);
  let reply = "";
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: promptFor(vin, known) }],
        temperature: 1,
        max_completion_tokens: 1024,
        reasoning_effort: "low",
        stream: false,
        tool_choice: "auto",
        tools: [{ type: "browser_search" }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 200);
      throw new Error(`Groq returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const data = await response.json() as { choices?: { message?: { content?: string | null } }[] };
    reply = data.choices?.[0]?.message?.content || "";
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error(`The AI VIN lookup took too long (${Math.round(aiTimeout / 1000)}s).`);
    throw error instanceof Error ? error : new Error("The AI VIN lookup failed.");
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseVinObject(reply);
  if (!parsed) throw new Error("The AI did not return readable VIN details.");
  const fields: Partial<Record<VinField, string>> = {};
  for (const field of vinFields) {
    const value = clean(parsed[field], field === "year" ? 20 : 100);
    if (!value) continue;
    if (field === "year" && !/^\d{4}$/.test(value)) continue;
    fields[field] = value;
  }
  return fields;
}

export async function lookupVin(vin: string): Promise<VinLookupResult> {
  const cached = cache.get(vin);
  if (cached && Date.now() - cached.at < cacheTtl) return cached.data;

  const decoded = await decodeVin(vin);
  const warnings = [...decoded.warnings];
  let suggestedFields: Partial<Record<VinField, string>> = {};
  try { suggestedFields = await askGroq(vin, decoded.fields); }
  catch (error) { warnings.push((error as Error).message); }

  // The decoder wins every field it answered; the AI only adds what is still missing.
  const fields: Partial<Record<VinField, string>> = { ...decoded.fields };
  const suggested: VinField[] = [];
  for (const field of vinFields) {
    const value = suggestedFields[field];
    if (!value || fields[field]) continue;
    fields[field] = value;
    suggested.push(field);
  }

  const result: VinLookupResult = {
    vin,
    fields,
    decoded: vinFields.filter(field => Boolean(decoded.fields[field])),
    suggested,
    warnings: [...new Set(warnings)],
  };
  cache.set(vin, { at: Date.now(), data: result });
  if (cache.size > 80) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 25);
    for (const [entry] of oldest) cache.delete(entry);
  }
  return result;
}
