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
    "Read the actual browser-search source snippets/pages: do not list generic search snippets as sources. Keep source results even when you cannot extract a numeric torque, so the user can open the source and paste its table manually.",
    "Return only one valid JSON object, with no markdown or prose, in this shape:",
    '{"results":[{"title":"Source page title","url":"https://...","snippet":"Short exact supporting text from the page"}],"candidates":[{"fastener":"Front lower arm bolt","stage":"1","value":90,"unit":"Nm","sourceIndex":1,"sourceTitle":"Source page title","sourceUrl":"https://...","snippet":"Short exact supporting text"}]}',
    `Use only these torque units: Nm, lbf·ft, lbf·in, kgf·m. Return at most ${maxRows} candidates. Use an empty string when a stage is not specified and empty arrays when no reliable result is found. Include the 1-based sourceIndex for each torque row, matching its source in results, and copy the source URL exactly. Include direct source-page URLs, not search-result URLs.`,
  ].join("\n");
}

function parseJsonObject(reply: string): Record<string, unknown> | null {
  // Browser-search citations can be appended to the answer after the JSON. Find
  // the first complete JSON object instead of parsing everything through the
  // final brace in the response.
  for (let start = 0; start < reply.length; start++) {
    if (reply[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < reply.length; end++) {
      const char = reply[end];
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
          const value: unknown = JSON.parse(reply.slice(start, end + 1));
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const object = value as Record<string, unknown>;
            if ("candidates" in object || "results" in object || "torques" in object) return object;
          }
        } catch { /* Try the next opening brace in case this one was prose. */ }
        break;
      }
    }
  }
  return null;
}

function canonicalSourceUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.searchParams.sort();
  while (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.pathname === "/" && !url.search ? url.origin : `${url.origin}${url.pathname}${url.search}`;
}

function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return canonicalSourceUrl(url.toString());
  } catch {
    return null;
  }
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function normalizeSources(...values: unknown[]): TorqueSearchSource[] {
  const sources = new Map<string, TorqueSearchSource>();
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const url = safeSourceUrl(row.url);
      if (!url) continue;
      const title = cleanText(row.title, 200) || new URL(url).hostname;
      const snippet = cleanText(row.snippet, 400);
      const prior = sources.get(url);
      sources.set(url, { title: prior?.title || title, url, snippet: prior?.snippet || snippet });
      if (sources.size >= 10) return [...sources.values()];
    }
  }
  return [...sources.values()];
}

function citationSources(value: unknown, content: string): TorqueSearchSource[] {
  if (!Array.isArray(value)) return [];
  const sources: TorqueSearchSource[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const annotation = item as Record<string, unknown>;
    const citation = annotation.url_citation && typeof annotation.url_citation === "object"
      ? annotation.url_citation as Record<string, unknown>
      : annotation;
    const url = safeSourceUrl(citation.url);
    if (!url) continue;
    const start = typeof citation.start_index === "number" ? citation.start_index : -1;
    const end = typeof citation.end_index === "number" ? citation.end_index : -1;
    const excerpt = start >= 0 && end > start
      ? content.slice(start, end)
      : start >= 0 ? content.slice(Math.max(0, start - 100), Math.min(content.length, start + 220)) : "";
    sources.push({
      title: cleanText(citation.title, 200) || new URL(url).hostname,
      url,
      snippet: cleanText(excerpt, 400),
    });
  }
  return sources;
}

function normalizeCandidates(value: unknown, sources: TorqueSearchSource[]): TorqueSearchCandidate[] {
  if (!Array.isArray(value)) return [];
  const knownSources = new Map(sources.map(source => [source.url, source]));
  const rows = new Map<string, TorqueSearchCandidate>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const fastener = cleanText(row.fastener ?? row.component, 200);
    const rawTorque = row.value ?? row.torque ?? row.torqueValue;
    const combined = typeof rawTorque === "string" ? rawTorque.trim().match(/^(\d{1,4}(?:[.,]\d{1,3})?)\s+(.+)$/) : null;
    const value = cleanTorqueValue(combined?.[1] ?? rawTorque);
    const unit = normalizeTorqueUnit(row.unit ?? row.torqueUnit) ?? normalizeTorqueUnit(combined?.[2]);
    const requestedUrl = safeSourceUrl(row.sourceUrl ?? row.url);
    const requestedTitle = cleanText(row.sourceTitle ?? row.source, 200).toLowerCase();
    const sourceIndex = Number(row.sourceIndex ?? row.citationIndex);
    if (fastener.length < 2 || value === null || !unit) continue;
    const source = (requestedUrl && knownSources.get(canonicalSourceUrl(requestedUrl)))
      || (requestedTitle && sources.find(item => item.title.toLowerCase() === requestedTitle))
      || (Number.isInteger(sourceIndex) && sourceIndex >= 1 ? sources[sourceIndex - 1] : undefined)
      || (sources.length === 1 ? sources[0] : undefined);
    if (!source) continue;
    const sourceUrl = source.url;
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

interface GroqSearchReply {
  content: string;
  sources: TorqueSearchSource[];
}

async function askGroq(vehicle: SearchVehicle): Promise<GroqSearchReply> {
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
        citation_options: "enabled",
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
    const data = await response.json() as {
      choices?: { message?: { content?: string | null; annotations?: unknown } }[];
    };
    const message = data.choices?.[0]?.message;
    const content = message?.content || "";
    return { content, sources: citationSources(message?.annotations, content) };
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
  const parsed = parseJsonObject(reply.content);
  if (!parsed) fail(502, "Groq did not return torque results in the expected format. Try again.");

  const results = normalizeSources(parsed.results, parsed.sources, reply.sources, citationSources(parsed.citations, reply.content));
  const candidates = normalizeCandidates(parsed.candidates ?? parsed.torques, results);
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
