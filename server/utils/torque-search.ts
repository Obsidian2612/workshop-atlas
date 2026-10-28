import { fail } from "./store";
import { cleanTorqueValue, normalizeTorqueUnit } from "./torques";
import type { TorqueSearchCandidate, TorqueSearchResponse, TorqueSearchSource } from "../../src/lib/workshop-types";

interface SearchVehicle {
  make: string;
  model: string;
  year: string;
  engine: string;
  engineModel: string;
  engineNumber: string;
  vin: string;
}

const timeoutMs = Number(process.env.GROQ_TIMEOUT_MS) || 60_000;
const maxRows = 40;
const cacheTtl = 10 * 60 * 1000;
const cache = new Map<string, { at: number; data: TorqueSearchResponse }>();
const endpoint = "https://api.groq.com/openai/v1/chat/completions";

function vehicleDescription(vehicle: SearchVehicle) {
  return [
    vehicle.year,
    vehicle.make,
    vehicle.model,
    vehicle.engineModel ? `engine model ${vehicle.engineModel}` : "",
    vehicle.engineNumber ? `engine number ${vehicle.engineNumber}` : "",
    vehicle.engine ? `engine variant ${vehicle.engine}` : "",
    vehicle.vin ? `VIN ${vehicle.vin}` : "",
  ].filter(Boolean).join(" ");
}

function promptFor(vehicle: SearchVehicle) {
  return [
    `Research manufacturer tightening-torque specifications for this exact vehicle: ${vehicleDescription(vehicle)}.`,
    "Use your browser_search tool to find real source pages. Prefer OEM service information or a reputable workshop manual that identifies the matching vehicle and engine.",
    "Never infer values from a related model/year and never invent a torque. Include a candidate only when the cited source clearly supports the exact fastener, value and unit. If you cannot verify a value, omit it.",
    "Return only one valid JSON object, with no markdown or prose, in this shape:",
    '{"results":[{"title":"Source page title","url":"https://...","snippet":"Short exact supporting text from the page"}],"candidates":[{"fastener":"Front lower arm bolt","stage":"1","value":90,"unit":"Nm","sourceTitle":"Source page title","sourceUrl":"https://...","snippet":"Short exact supporting text"}]}',
    `Use only these torque units: Nm, lbf·ft, lbf·in, kgf·m. Return at most ${maxRows} candidates. Use an empty string when a stage is not specified and empty arrays when no reliable result is found. Include direct source-page URLs, not search-result URLs.`,
  ].join("\n");
}

function parseJsonObject(reply: string): Record<string, unknown> | null {
  const content = reply.replace(/```(?:json)?/gi, "").trim();
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(content.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function normalizeSources(value: unknown): TorqueSearchSource[] {
  if (!Array.isArray(value)) return [];
  const sources = new Map<string, TorqueSearchSource>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const url = safeSourceUrl(row.url);
    if (!url) continue;
    const title = cleanText(row.title, 200) || new URL(url).hostname;
    const snippet = cleanText(row.snippet, 400);
    sources.set(url, { title, url, snippet });
    if (sources.size >= 10) break;
  }
  return [...sources.values()];
}

function normalizeCandidates(value: unknown, sources: TorqueSearchSource[]): TorqueSearchCandidate[] {
  if (!Array.isArray(value)) return [];
  const knownSources = new Map(sources.map(source => [source.url, source]));
  const rows = new Map<string, TorqueSearchCandidate>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const fastener = cleanText(row.fastener, 200);
    const value = cleanTorqueValue(row.value ?? row.torque);
    const unit = normalizeTorqueUnit(row.unit);
    const sourceUrl = safeSourceUrl(row.sourceUrl ?? row.url);
    if (fastener.length < 2 || value === null || !unit || !sourceUrl) continue;
    const source = knownSources.get(sourceUrl);
    if (!source) continue;
    const sourceTitle = source.title;
    const snippet = cleanText(row.snippet ?? source.snippet, 300);
    const stage = cleanText(row.stage, 40);
    const key = `${fastener.toLowerCase()}|${stage.toLowerCase()}|${value}|${unit}`;
    const existing = rows.get(key);
    if (existing) { existing.mentions += 1; continue; }
    rows.set(key, { fastener, stage, value, unit, sourceTitle, sourceUrl, snippet, mentions: 1 });
    if (rows.size >= maxRows) break;
  }
  return [...rows.values()].sort((a, b) => a.fastener.localeCompare(b.fastener));
}

async function askGroq(vehicle: SearchVehicle): Promise<string> {
  const key = (process.env.GROQ_API_KEY || "").trim();
  if (!key) fail(503, "GROQ_API_KEY is not configured on the server");
  const model = (process.env.GROQ_MODEL || "openai/gpt-oss-20b").trim();
  if (!["openai/gpt-oss-20b", "openai/gpt-oss-120b"].includes(model)) {
    fail(500, "GROQ_MODEL must be openai/gpt-oss-20b or openai/gpt-oss-120b to use Groq browser search.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(endpoint, {
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
    if ((error as Error).name === "AbortError") fail(504, `Groq web search took too long (${Math.round(timeoutMs / 1000)}s). Try again.`);
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

export async function searchTorqueSpecs(vehicle: SearchVehicle): Promise<TorqueSearchResponse> {
  const query = vehicleDescription(vehicle);
  const cacheKey = [process.env.GROQ_MODEL || "openai/gpt-oss-20b", vehicle.make, vehicle.model, vehicle.year, vehicle.engine, vehicle.engineModel, vehicle.engineNumber, vehicle.vin].join("|").toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < cacheTtl) return { ...cached.data, cached: true };

  const reply = await askGroq(vehicle);
  const parsed = parseJsonObject(reply);
  if (!parsed) fail(502, "Groq did not return torque results in the expected format. Try again.");

  const results = normalizeSources(parsed.results);
  const candidates = normalizeCandidates(parsed.candidates, results);
  const data: TorqueSearchResponse = {
    query,
    provider: "Groq browser search",
    results,
    candidates,
    fetched: results.length,
  };
  cache.set(cacheKey, { at: Date.now(), data });
  if (cache.size > 60) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 20);
    for (const [entry] of oldest) cache.delete(entry);
  }
  return data;
}
