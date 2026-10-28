import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fail } from "./store";
import { parseTorqueLine } from "./torques";
import type { TorqueSearchCandidate, TorqueSearchResponse, TorqueSearchSource } from "../../src/lib/workshop-types";

/*
 * Online torque search is deliberately a two-step read: a configured search
 * provider returns result links, the server reads a few of those pages, and the
 * UI shows the parsed rows for confirmation. Nothing is written from here, and
 * a provider is never contacted unless an administrator has configured one.
 *
 * Pages are fetched server-side, so every URL (including redirects) is checked
 * against private address ranges first. Brave Search is the default provider;
 * other compatible providers can still be selected by server configuration.
 */

interface SearchVehicle {
  make: string;
  model: string;
  year: string;
  engine: string;
  engineModel: string;
  engineNumber: string;
  vin: string;
}

const timeout = Number(process.env.TORQUE_SEARCH_TIMEOUT_MS) || 8000;
const pageLimit = Math.min(Math.max(Number(process.env.TORQUE_SEARCH_PAGES) || 3, 1), 4);
const maxBytes = 1_500_000;
const cacheTtl = 10 * 60 * 1000;
const cache = new Map<string, { at: number; data: TorqueSearchResponse }>();

const rangePattern = /\b\d{1,4}(?:[.,]\d{1,3})?\s*(?:-|–|—|to)\s*\d{1,4}(?:[.,]\d{1,3})?\b/i;

function endpoint(): URL {
  const raw = (process.env.TORQUE_SEARCH_URL || "https://api.search.brave.com/res/v1/web/search").trim();
  let url: URL;
  try { url = new URL(raw); }
  catch { fail(400, "TORQUE_SEARCH_URL is not a valid URL."); }
  return url;
}

function providerName() {
  const value = (process.env.TORQUE_SEARCH_PROVIDER || "brave").trim().toLowerCase();
  if (!["google", "serper", "brave", "generic"].includes(value)) fail(400, "TORQUE_SEARCH_PROVIDER must be google, serper, brave or generic.");
  return value;
}

function buildQuery(vehicle: SearchVehicle) {
  // Engine model/number help distinguish variants. VIN is a fallback when no
  // engine identifier is recorded; VIN-only web results rarely carry tables.
  const engineIdentity = [vehicle.engineModel, vehicle.engineNumber, vehicle.engine].filter(Boolean);
  const parts = [vehicle.make, vehicle.model, vehicle.year, ...engineIdentity];
  if (!engineIdentity.length && vehicle.vin) parts.push(vehicle.vin);
  return `${parts.join(" ").trim()} tightening torque specifications`.trim();
}

function normalizeSources(payload: unknown): TorqueSearchSource[] {
  let list: unknown[] = [];
  if (Array.isArray(payload)) list = payload;
  else if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const web = record.web && typeof record.web === "object" ? record.web as Record<string, unknown> : undefined;
    for (const value of [record.items, record.organic, record.results, record.data, web?.results]) {
      if (Array.isArray(value)) { list = value; break; }
    }
  }
  return list.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const url = typeof (row.link ?? row.url) === "string" ? String(row.link ?? row.url).trim() : "";
    if (!/^https?:\/\//i.test(url)) return [];
    const title = typeof row.title === "string" ? row.title.replace(/\s+/g, " ").trim() : url;
    const snippet = typeof (row.snippet ?? row.description) === "string" ? String(row.snippet ?? row.description).replace(/\s+/g, " ").trim() : "";
    return [{ title: (title || url).slice(0, 200), url, snippet: snippet.slice(0, 400) }];
  }).slice(0, 10);
}

async function requestSearch(query: string): Promise<TorqueSearchSource[]> {
  const url = endpoint();
  const provider = providerName();
  const key = (process.env.TORQUE_SEARCH_KEY || "").trim();
  const headers: Record<string, string> = { Accept: "application/json" };
  let init: RequestInit = { method: "GET", headers };
  if (provider === "google") {
    const engineId = (process.env.TORQUE_SEARCH_ENGINE_ID || "").trim();
    if (!key || !engineId) fail(400, "Google search needs TORQUE_SEARCH_KEY and TORQUE_SEARCH_ENGINE_ID. Note that Google's Custom Search JSON API is closed to new customers, so an existing key is required.");
    url.searchParams.set("key", key);
    url.searchParams.set("cx", engineId);
    url.searchParams.set("q", query);
    url.searchParams.set("num", "10");
  } else if (provider === "serper") {
    if (!key) fail(400, "TORQUE_SEARCH_KEY is required for the serper provider.");
    headers["X-API-KEY"] = key;
    headers["Content-Type"] = "application/json";
    init = { method: "POST", headers, body: JSON.stringify({ q: query, num: 10 }) };
  } else if (provider === "brave") {
    if (!key) fail(400, "TORQUE_SEARCH_KEY is required for the brave provider.");
    headers["X-Subscription-Token"] = key;
    url.searchParams.set("q", query);
    url.searchParams.set("count", "10");
  } else {
    if (key) headers.Authorization = `Bearer ${key}`;
    url.searchParams.set("q", query);
    url.searchParams.set("num", "10");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) fail(502, `The search provider returned ${response.status}. Check TORQUE_SEARCH_URL and its key.`);
    return normalizeSources(await response.json());
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) throw error;
    console.warn("Torque search provider failed", error);
    fail(502, "The search provider could not be reached. Check the server's network access and TORQUE_SEARCH_URL.");
  } finally {
    clearTimeout(timer);
  }
}

function privateAddress(address: string) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  if (version === 6) {
    const value = address.toLowerCase();
    const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateAddress(mapped[1]);
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd")
      || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
  }
  return true;
}

async function assertPublicUrl(target: URL) {
  if (!["http:", "https:"].includes(target.protocol)) fail(502, "A search result used an unsupported link.");
  if (target.username || target.password) fail(502, "A search result link contained credentials.");
  // Only for local development tests; never enable this on a deployed server.
  if (process.env.TORQUE_SEARCH_ALLOW_PRIVATE === "1") return;
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) fail(502, "A search result pointed at a private address.");
  let addresses: { address: string }[];
  if (isIP(host)) addresses = [{ address: host }];
  else {
    try { addresses = await lookup(host, { all: true }); }
    catch { fail(502, "A search result link could not be resolved."); }
  }
  if (!addresses.length || addresses.some(entry => privateAddress(entry.address))) fail(502, "A search result pointed at a private address.");
}

async function fetchPage(raw: string): Promise<string> {
  let target = new URL(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    for (let hop = 0; hop <= 3; hop++) {
      await assertPublicUrl(target);
      const response = await fetch(target, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "WorkshopAtlas/1.0 (torque specification lookup)",
          Accept: "text/html,text/plain;q=0.9",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) fail(502, "A search result link redirected without a location.");
        target = new URL(location, target);
        continue;
      }
      if (!response.ok) fail(502, `A source page returned ${response.status}.`);
      const type = response.headers.get("content-type") || "";
      if (!/text\/(html|plain)/i.test(type)) fail(502, "A source page was not readable text.");
      const declared = Number(response.headers.get("content-length")) || 0;
      if (declared > maxBytes) fail(502, "A source page was too large to read.");
      const reader = response.body?.getReader();
      if (!reader) return "";
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); fail(502, "A source page was too large to read."); }
        chunks.push(value);
      }
      return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8");
    }
    fail(502, "A search result redirected too many times.");
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) throw error;
    console.warn("Torque source page failed", raw, error);
    fail(502, "A search result page could not be read.");
  } finally {
    clearTimeout(timer);
  }
}

const entities: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  deg: "°", middot: "·", times: "×", plusmn: "±", frac12: "½",
};

function decodeEntities(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return entities[entity.toLowerCase()] ?? match;
  });
}

function htmlToText(html: string) {
  const cleaned = html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(tr|p|div|li|h[1-6]|section|article|table|ul|ol|main|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(cleaned)
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function collectCandidates(text: string, source: TorqueSearchSource, into: Map<string, TorqueSearchCandidate>) {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length < 6 || line.length > 400) continue;
    const spec = parseTorqueLine(line);
    if (!spec || spec.value > 1000) continue;
    // A single numeric value is required by the data model, so ranges are not
    // silently turned into one endpoint value.
    if (rangePattern.test(line)) continue;
    const key = `${spec.fastener.toLowerCase()}|${spec.stage}|${spec.value}|${spec.unit}`;
    const existing = into.get(key);
    if (existing) { existing.mentions += 1; continue; }
    into.set(key, { ...spec, sourceTitle: source.title, sourceUrl: source.url, snippet: line.slice(0, 300), mentions: 1 });
  }
}

export async function searchTorqueSpecs(vehicle: SearchVehicle): Promise<TorqueSearchResponse> {
  const provider = providerName();
  const query = buildQuery(vehicle);
  const key = [provider, vehicle.make, vehicle.model, vehicle.year, vehicle.engine, vehicle.engineModel, vehicle.engineNumber, vehicle.vin].join("|").toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < cacheTtl) return { ...cached.data, cached: true };
  const found = await requestSearch(query);
  if (!found.length) fail(404, `No web results were found for “${query}”.`);
  const results = found.slice(0, pageLimit);
  const candidates = new Map<string, TorqueSearchCandidate>();
  let fetched = 0;
  await Promise.all(results.map(async source => {
    try {
      collectCandidates(htmlToText(await fetchPage(source.url)), source, candidates);
      fetched++;
    } catch (error) {
      // One unreadable page must not lose the others; its link is still listed.
      console.warn("Torque page skipped", source.url, error instanceof Error ? error.message : error);
    }
  }));
  const data: TorqueSearchResponse = {
    query,
    provider,
    results,
    candidates: [...candidates.values()]
      .sort((a, b) => b.mentions - a.mentions || a.fastener.localeCompare(b.fastener))
      .slice(0, 40),
    fetched,
  };
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 60) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 20);
    for (const [entry] of oldest) cache.delete(entry);
  }
  return data;
}
