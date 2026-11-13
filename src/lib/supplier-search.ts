import type { Supplier, Vehicle, WorkshopRecord } from "./workshop-types";

/*
 * Sourcing a part starts from what the counter already knows: the vehicle in
 * front of them and, once it is off, the number on the old part. Suppliers each
 * word their own search differently, so a supplier may store its own search
 * address with a {query} slot; otherwise the search is narrowed to the
 * supplier's site and handed to a search engine.
 */

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

export function supplierSearchUrl(supplier: Supplier, query: string) {
  const terms = query.trim();
  const template = supplier.searchUrl.trim();
  if (template.includes("{query}")) return template.split("{query}").join(encodeURIComponent(terms));
  let host = "";
  try { host = new URL(supplier.website).hostname.replace(/^www\./, ""); } catch { host = ""; }
  return `https://www.google.com/search?q=${encodeURIComponent((host ? `site:${host} ` : "") + terms).trim()}`;
}
