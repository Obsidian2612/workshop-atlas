import type { Supplier, Vehicle, WorkshopRecord } from "./workshop-types";

/*
 * Sourcing a part starts from what the counter already knows: the vehicle in
 * front of them and, once it is off, the number on the old part. Suppliers each
 * word their own search differently, so a supplier may store its own search
 * address with a {query} slot; otherwise the search is narrowed to the
 * supplier's site and handed to a search engine.
 */

/*
 * Some suppliers run their own catalogue search that takes the query in the link.
 * Those patterns are checked in the workspace against the real site, so a shop
 * gets a direct search without having to work the link out by hand.
 */
const knownCatalogues: { host: RegExp; search: (query: string) => string }[] = [
  // Goldwagen's Parts Finder searches OE numbers, GW numbers and descriptions.
  { host: /(^|\.)goldwagen\.com$/i, search: query => `https://partsfinder.goldwagen.com/PartsFinder/Index?stext=${encodeURIComponent(query)}` },
];

export function knownCatalogueUrl(website: string, query: string): string | undefined {
  let host = "";
  try { host = new URL(website).hostname; } catch { return undefined; }
  const catalogue = knownCatalogues.find(entry => entry.host.test(host));
  return catalogue ? catalogue.search(query.trim()) : undefined;
}

export function vehicleQuery(vehicle?: Vehicle | null, mode: "vin" | "identity" = "identity") {
  if (!vehicle) return "";
  if (mode === "vin") return (vehicle.vin || "").trim().toUpperCase();
  return [vehicle.make, vehicle.model, vehicle.year, vehicle.engine]
    .map(value => (value || "").trim()).filter(Boolean).join(" ");
}

/** The number to order, who makes it, then the vehicle it fits. */
export function partQuery(part: WorkshopRecord, vehicle?: Vehicle | null) {
  return [part.partNumber, part.partMake, part.title, vehicleQuery(vehicle)]
    .map(value => (value || "").trim()).filter(Boolean).join(" ");
}

/** A plain web search, used when no supplier is involved (for example a VIN lookup). */
export function webSearchUrl(query: string) {
  return `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`;
}

/*
 * A catalogue search is a text match on the supplier's own site, so it takes only
 * the number or the part's name — extra words like the vehicle's engine make it
 * return nothing. A web search, on the other hand, is better with every term.
 */
export function supplierSearchUrl(supplier: Supplier, query: string, catalogueQuery?: string) {
  const terms = query.trim();
  // Only a part can be looked up in a supplier's catalogue: their finders match a
  // number or a description, and a VIN or a model name comes back empty.
  const lean = (catalogueQuery || "").trim();
  const template = supplier.searchUrl.trim();
  if (template.includes("{query}")) return template.split("{query}").join(encodeURIComponent(lean || terms));
  if (lean) {
    const known = knownCatalogueUrl(supplier.website, lean);
    if (known) return known;
  }
  let host = "";
  try { host = new URL(supplier.website).hostname.replace(/^www\./, ""); } catch { host = ""; }
  return `https://www.google.com/search?q=${encodeURIComponent((host ? `site:${host} ` : "") + terms).trim()}`;
}
