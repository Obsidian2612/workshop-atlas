import { fail } from "./store";
import type { PartSearchResponse, PartSearchResult } from "../../src/lib/workshop-types";

/*
 * "Clutch kit" is how the counter talks; a supplier's shop needs it as a search
 * of its own catalogue. Groq's browser search reads the suppliers' own product
 * pages, so each suggestion arrives with the number, the maker, the price the
 * page shows and the page it came from. A picture is only ever taken from that
 * page (its own preview image) — nothing is drawn or guessed.
 */

export interface SearchSupplier { id: string; name: string; website: string }
interface SearchVehicle { make: string; model: string; year: string; engine: string }

const timeoutMs = Number(process.env.GROQ_TIMEOUT_MS) || 60_000;
const pageTimeoutMs = 8_000;
const maxResults = 12;
const cacheTtl = 10 * 60 * 1000;
const cache = new Map<string, { at: number; data: PartSearchResponse }>();
const endpoint = "https://api.groq.com/openai/v1/chat/completions";

function describeVehicle(vehicle?: SearchVehicle | null) {
  if (!vehicle) return "";
  return [vehicle.year, vehicle.make, vehicle.model, vehicle.engine].map(value => (value || "").trim()).filter(Boolean).join(" ");
}

function promptFor(term: string, vehicle: SearchVehicle | null | undefined, suppliers: SearchSupplier[]) {
  const vehicleText = describeVehicle(vehicle);
  return [
    `Find where this part can be bought in South Africa: "${term}".`,
    vehicleText
      ? `It is for this vehicle: ${vehicleText}. Prefer parts whose page lists this vehicle or its engine as a fitment.`
      : "No vehicle is chosen, so include the parts a workshop would most likely fit normally.",
    "Use your browser_search tool to search these suppliers' own websites:",
    suppliers.map(supplier => `${supplier.name} (${supplier.website})`).join("; "),
    "Only list real products you found on one of those suppliers' own pages. Copy the product page address exactly as it appears in the results, never a search-result address and never a made-up one. Never invent a part number, a brand, a price or an image address.",
    "Return only one JSON object, with no markdown, prose or code fences:",
    '{"parts":[{"title":"Clutch kit 3-piece","partNumber":"GW1234","make":"Sachs","supplier":"Goldwagen","price":"R2 450","url":"https://...","image":"https://...","snippet":"short exact text from the product page"}],"sources":[{"title":"Page title","url":"https://...","snippet":"short exact text"}]}',
    `Give at most ${maxResults} parts, covering every supplier that lists a match. Leave partNumber, make, price or image empty when the page does not show it. A product page often names the fitment, the number and the price in its listing text — keep those exact.`,
  ].join("\n");
}

/** Lift the first complete JSON object out of a reply that may wrap it in prose or a code fence. */
function parseReply(reply: string): Record<string, unknown> | null {
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
            if ("parts" in object || "products" in object || "results" in object) return object;
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
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function siteHost(website: string) {
  try { return new URL(website).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

/** Whether an address belongs to a supplier's own site (or one of its subdomains). */
function onSite(url: string, website: string) {
  const host = siteHost(url);
  const site = siteHost(website);
  return Boolean(host && site && (host === site || host.endsWith(`.${site}`)));
}

/**
 * The supplier a product page belongs to. The shop the model named wins, then the
 * site the address is on, so a shop's own subdomain still lands on that shop.
 */
function supplierFor(url: string, named: string, suppliers: SearchSupplier[]) {
  const byName = suppliers.find(supplier => supplier.name.toLowerCase() === named);
  if (byName && onSite(url, byName.website)) return byName;
  return suppliers.find(supplier => onSite(url, supplier.website));
}

function cleanResults(value: unknown, suppliers: SearchSupplier[]): PartSearchResult[] {
  const list = Array.isArray(value) ? value : [];
  const results = new Map<string, PartSearchResult>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const title = cleanText(row.title ?? row.name ?? row.product, 200);
    const url = safeUrl(row.url ?? row.link ?? row.productUrl);
    if (title.length < 2 || !url) continue;
    const supplier = supplierFor(url, cleanText(row.supplier, 100).toLowerCase(), suppliers);
    // A part with no supplier behind it cannot be checked or ordered from here.
    if (!supplier) continue;
    const partNumber = cleanText(row.partNumber ?? row.number ?? row.sku, 60);
    const key = `${url}|${partNumber.toLowerCase()}`;
    if (results.has(key)) continue;
    results.set(key, {
      title,
      partNumber,
      partMake: cleanText(row.make ?? row.brand ?? row.manufacturer, 60),
      price: cleanText(row.price, 40),
      supplierId: supplier.id,
      supplierName: supplier.name,
      url,
      imageUrl: safeUrl(row.image ?? row.imageUrl ?? row.picture) || "",
      snippet: cleanText(row.snippet ?? row.note ?? row.description, 300),
    });
    if (results.size >= maxResults) break;
  }
  return [...results.values()];
}

const imagePatterns = [
  /<meta[^>]+(?:property|name)=["'](?:og:image(?::url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::url)?|twitter:image(?::src)?)["']/i,
  /<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/i,
];

function decodeEntities(value: string) {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#0*38;/g, "&").replace(/&#x0*26;/gi, "&");
}

/**
 * The picture a supplier's own page offers as its preview image. A shop that
 * blocks the request simply has no picture; the row still shows its number.
 */
async function pageImage(url: string, website: string): Promise<string> {
  if (!onSite(url, website)) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), pageTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "WorkshopAtlas/1.0 (+parts lookup)" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) return "";
    const html = (await response.text()).slice(0, 400_000);
    for (const pattern of imagePatterns) {
      const match = html.match(pattern);
      if (!match?.[1]) continue;
      // Shops often give the picture as a path within their own media folder.
      let absolute = "";
      try { absolute = new URL(decodeEntities(match[1]), url).toString(); } catch { absolute = ""; }
      const image = safeUrl(absolute);
      if (image) return image;
    }
    return "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

interface GroqPartsReply { content: string; truncated: boolean }

async function askGroq(term: string, vehicle: SearchVehicle | null, suppliers: SearchSupplier[]): Promise<GroqPartsReply> {
  const key = (process.env.GROQ_API_KEY || "").trim();
  if (!key) fail(503, "GROQ_API_KEY is not configured on the server");
  const model = (process.env.GROQ_MODEL || "openai/gpt-oss-20b").trim();
  if (!["openai/gpt-oss-20b", "openai/gpt-oss-120b"].includes(model)) {
    fail(500, "GROQ_MODEL must be openai/gpt-oss-20b or openai/gpt-oss-120b to search suppliers.");
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
        messages: [{ role: "user", content: promptFor(term, vehicle, suppliers) }],
        temperature: 1,
        // Room for reasoning plus a dozen products, so a long answer is not cut short.
        max_completion_tokens: 8192,
        reasoning_effort: "low",
        stream: false,
        tool_choice: "required",
        tools: [{ type: "browser_search" }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") fail(504, `The supplier search took too long (${Math.round(timeoutMs / 1000)}s). Try again.`);
    fail(502, "The supplier search could not be reached. Check the server's network access and GROQ_API_KEY.");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240);
    fail(502, `Groq returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  try {
    const data = await response.json() as {
      choices?: { finish_reason?: string; message?: { content?: string | null } }[];
    };
    const choice = data.choices?.[0];
    return { content: choice?.message?.content || "", truncated: choice?.finish_reason === "length" };
  } catch {
    fail(502, "Groq returned an unreadable response.");
  }
}

export async function searchParts(input: { term: string; vehicle?: SearchVehicle | null; suppliers: SearchSupplier[] }): Promise<PartSearchResponse> {
  const term = input.term.replace(/\s+/g, " ").trim().slice(0, 100);
  if (term.length < 2) fail(400, "Type the name of the part, for example clutch kit or dipstick");
  const suppliers = input.suppliers.filter(supplier => supplier.name && supplier.website).slice(0, 20);
  if (!suppliers.length) fail(400, "Add a supplier in Settings & members before searching their shelves");

  const vehicle = input.vehicle ?? null;
  const cacheKey = [process.env.GROQ_MODEL || "openai/gpt-oss-20b", term, describeVehicle(vehicle), suppliers.map(supplier => supplier.id).join(",")]
    .join("|").toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < cacheTtl) return { ...cached.data, cached: true };

  const reply = await askGroq(term, vehicle, suppliers);
  const parsed = parseReply(reply.content);
  if (!parsed) fail(502, "Groq did not return parts in the expected format. Try again.");

  const results = cleanResults(parsed?.parts ?? parsed?.products ?? parsed?.results, suppliers);
  const websites = new Map(suppliers.map(supplier => [supplier.id, supplier.website]));
  // Pictures are read from the supplier's own page, so a suggestion never shows
  // an image that page does not offer.
  await Promise.all(results.map(async result => {
    if (result.imageUrl) return;
    result.imageUrl = await pageImage(result.url, websites.get(result.supplierId) || "");
  }));

  const data: PartSearchResponse = {
    query: term,
    vehicle: describeVehicle(vehicle),
    provider: "Groq supplier search",
    results,
  };
  // A half-written answer is kept out of the cache so the next search asks again.
  if (!reply.truncated) cache.set(cacheKey, { at: Date.now(), data });
  if (cache.size > 60) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 20);
    for (const [entry] of oldest) cache.delete(entry);
  }
  return data;
}
