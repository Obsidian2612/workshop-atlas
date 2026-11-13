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
  // AutoZone South Africa takes the keyword in `k`; the empty `q` is part of the
  // address — without it the result list comes back empty.
  { host: /(^|\.)autozoneonline\.co\.za$/i, search: query => `https://www.autozoneonline.co.za/search/text/input?q=&k=${encodeURIComponent(query)}` },
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

/**
 * What a catalogue can actually match for a vehicle: the make and the model.
 * Goldwagen and AutoZone both list parts for "Volkswagen Golf 7", but the full
 * description with the year and the engine comes back empty on their finders.
 */
export function vehicleCatalogueQuery(vehicle?: Vehicle | null) {
  if (!vehicle) return "";
  return [vehicle.make, vehicle.model]
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
 * the number, the part's name or the vehicle's make and model — extra words like
 * the engine make it return nothing. A web search is better with every term.
 */
export function supplierSearchUrl(supplier: Supplier, query: string, catalogueQuery?: string, vin?: string) {
  const terms = query.trim();
  const lean = (catalogueQuery || "").trim();
  const template = supplier.searchUrl.trim();
  if (template.includes("{query}")) return fillTemplate(template, { query: lean || terms, vin });
  if (lean) {
    const known = knownCatalogueUrl(supplier.website, lean);
    if (known) return known;
  }
  return siteSearch(supplier, terms);
}

/*
 * The vehicle a job is booked in for: the supplier's catalogue opens on its make
 * and model, so it is already showing that car's parts before the counter picks a
 * department. Neither Goldwagen's nor AutoZone's VIN box can be opened straight
 * from a link — Goldwagen's needs a logged-in account and AutoZone's errors — so a
 * VIN keeps going to a web search until a supplier offers a public VIN address.
 */
export function supplierVehicleUrl(supplier: Supplier, vehicle?: Vehicle | null) {
  const terms = vehicleQuery(vehicle);
  const template = supplier.searchUrl.trim();
  const vin = vehicleQuery(vehicle, "vin");
  if (template.includes("{query}")) return fillTemplate(template, { query: terms, vin });
  return supplierSearchUrl(supplier, terms, vehicleCatalogueQuery(vehicle), vin);
}

/**
 * A supplier whose own search takes a VIN gets it filled in; everyone else still
 * goes through a web search on their site, because their VIN box cannot be opened
 * from a link.
 */
export function supplierVinUrl(supplier: Supplier, vehicle?: Vehicle | null) {
  const vin = vehicleQuery(vehicle, "vin");
  const template = supplier.searchUrl.trim();
  if (vin && template.includes("{vin}")) return fillTemplate(template, { query: vehicleQuery(vehicle), vin });
  return supplierSearchUrl(supplier, vin, undefined, vin);
}

function fillTemplate(template: string, values: { query?: string; vin?: string }) {
  return template
    .split("{query}").join(encodeURIComponent(values.query || ""))
    .split("{vin}").join(encodeURIComponent(values.vin || ""));
}

function siteSearch(supplier: Supplier, terms: string) {
  let host = "";
  try { host = new URL(supplier.website).hostname.replace(/^www\./, ""); } catch { host = ""; }
  return `https://www.google.com/search?q=${encodeURIComponent((host ? `site:${host} ` : "") + terms).trim()}`;
}
