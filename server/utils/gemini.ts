import { fail } from "./store";
import { cleanTorqueValue, normalizeTorqueUnit } from "./torques";
import type { TorqueSpec } from "../../src/lib/workshop-types";

const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS) || 20000;
const maxRows = 100;

export interface GeminiRepairRow {
  vin: string;
  operation: string;
  minutes: number;
}

export interface GeminiTorqueRow extends TorqueSpec {
  vin: string;
}

function cleanOperation(value: unknown) {
  const label = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return label.slice(0, 200);
}

function cleanMinutes(value: unknown) {
  const minutes = typeof value === "string" ? Number(value.replace(",", ".")) : Number(value);
  if (!Number.isFinite(minutes)) return null;
  const rounded = Math.round(minutes);
  return rounded >= 0 && rounded <= 1440 ? rounded : null;
}

/** Lift the first JSON array out of a reply; models sometimes wrap it in prose or a code fence. */
function jsonArray(reply: string): unknown[] {
  const body = reply.replace(/```(?:json)?/gi, "").trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function parseGeminiReply(reply: string, vin: string): GeminiRepairRow[] {
  const rows: GeminiRepairRow[] = [];
  const seen = new Set<string>();
  for (const item of jsonArray(reply)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const operation = cleanOperation(row.operation ?? row.name ?? row.description);
    const minutes = cleanMinutes(row.minutes ?? row.min ?? row.time);
    if (!operation || minutes === null) continue;
    const key = `${operation.toLowerCase()}\u0000${minutes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ vin, operation, minutes });
    if (rows.length >= maxRows) break;
  }
  return rows;
}

export function parseGeminiTorques(reply: string, vin: string): GeminiTorqueRow[] {
  const rows: GeminiTorqueRow[] = [];
  const seen = new Set<string>();
  for (const item of jsonArray(reply)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const fastener = cleanOperation(row.fastener ?? row.bolt ?? row.component);
    if (fastener.length < 2) continue;
    const value = cleanTorqueValue(row.value ?? row.torque);
    const unit = normalizeTorqueUnit(row.unit);
    if (value === null || !unit) continue;
    const stage = typeof row.stage === "string" || typeof row.stage === "number" ? String(row.stage).replace(/\s+/g, " ").trim().slice(0, 40) : "";
    const key = `${fastener.toLowerCase()}\u0000${stage.toLowerCase()}\u0000${value}\u0000${unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ vin, fastener, stage, value, unit });
    if (rows.length >= maxRows) break;
  }
  return rows;
}

async function askGemini(prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) fail(503, "GEMINI_API_KEY is not configured on the server");
  // The vehicle model is not the Gemini model; keep them separate.
  const target = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(target)}:generateContent?key=${encodeURIComponent(key)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") fail(504, "Gemini took too long to respond. Try again.");
    fail(502, `Gemini could not be reached: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240);
    fail(502, `Gemini returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const data = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  let reply = "";
  for (const candidate of data.candidates || []) {
    for (const part of candidate.content?.parts || []) reply += part.text || "";
  }
  return reply;
}

function vehicleLabel(make?: string, model?: string, year?: string, engine?: string) {
  return [year, make, model, engine ? `engine ${engine}` : ""].filter(Boolean).join(" ").trim();
}

export async function fetchGeminiRepairTimes(vin: string, make?: string, model?: string, year?: string): Promise<GeminiRepairRow[]> {
  const vehicle = vehicleLabel(make, model, year);
  const prompt = [
    `Give the manufacturer-standard workshop repair times for VIN ${vin}${vehicle ? ` (${vehicle})` : ""}.`,
    "Reply with a JSON array only — no prose, no code fences.",
    'Format: [{"operation":"Replace front brake pads","minutes":60}]',
    "minutes must be a whole number between 0 and 1440. Use short operation names.",
    `Return at most ${maxRows} operations. If the vehicle is unknown, reply with [].`,
  ].join("\n");
  return parseGeminiReply(await askGemini(prompt), vin);
}

export async function fetchGeminiTorques(vin: string, make?: string, model?: string, year?: string, engine?: string, engineModel?: string, engineNumber?: string): Promise<GeminiTorqueRow[]> {
  const subject = [
    vehicleLabel(make, model, year, engine),
    engineModel ? `engine model ${engineModel}` : "",
    engineNumber ? `engine number ${engineNumber}` : "",
    vin ? `VIN ${vin}` : "",
  ].filter(Boolean).join(", ") || "this vehicle";
  const prompt = [
    `Give the manufacturer tightening torque specifications for ${subject}.`,
    "Reply with a JSON array only — no prose, no code fences.",
    'Format: [{"fastener":"Front lower arm bolt","stage":"1","value":90,"unit":"Nm"}]',
    'unit must be one of "Nm", "lbf·ft", "lbf·in" or "kgf·m". value must be a number greater than 0.',
    'stage is optional: "1", "2" or a short label.',
    "Return at most 40 fasteners. If the vehicle is unknown, reply with []. Do not invent values.",
  ].join("\n");
  return parseGeminiTorques(await askGemini(prompt), vin);
}
