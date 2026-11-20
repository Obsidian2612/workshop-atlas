import { randomUUID } from "node:crypto";
import type { Supplier } from "../../src/lib/workshop-types";

/*
 * The shops a South African workshop orders from most often, so a new workspace
 * starts ready to search a part instead of waiting for each counter to type in
 * the same names and addresses. The addresses were checked against the live
 * sites; only the website is stored, because the app already knows which of them
 * take a search query in the link and searches the rest through the web.
 */
export const supplierPresets: { name: string; website: string }[] = [
  { name: "Goldwagen", website: "https://www.goldwagen.com" },
  { name: "AutoZone", website: "https://www.autozoneonline.co.za" },
  { name: "Midas", website: "https://midas.co.za" },
  { name: "Modern Auto Parts", website: "https://modernautoparts.co.za" },
  { name: "Alert Engine Parts", website: "https://www.alert.co.za" },
  { name: "Diesel-Electric", website: "https://www.diesel-electric.co.za" },
  { name: "Masterparts", website: "https://www.masterparts.com" },
  { name: "Start My Car", website: "https://www.startmycar.co.za" },
  { name: "Spares Direct", website: "https://sparesdirect.co.za" },
  { name: "Imcomex", website: "https://www.imcomex.co.za" },
  { name: "Autobax", website: "https://www.autobax.co.za" },
  { name: "Sabat", website: "https://www.sabat.co.za" },
  { name: "Bearing Man Group", website: "https://www.bmgworld.net" },
];

/** The host an address is served from, without a leading www. */
export function siteHost(value: string) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

/**
 * Whether two addresses belong to the same shop. A shop often keeps its catalogue
 * on a subdomain (partsfinder.goldwagen.com), so a subdomain of a listed site is
 * that site and not a second shop.
 */
export function sharesSite(a: string, b: string) {
  const left = siteHost(a);
  const right = siteHost(b);
  return Boolean(left && right && (left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`)));
}

/**
 * Every preset the workshop does not already list, ready to be put in front of
 * the existing ones. A shop that is already there keeps its own address and
 * search links, so loading the list twice changes nothing.
 */
export function addSupplierPresets(suppliers: Supplier[], author: string, now = new Date().toISOString()): Supplier[] {
  const listed = new Set(suppliers.map(supplier => supplier.name.trim().toLowerCase()));
  const added: Supplier[] = [];
  for (const preset of supplierPresets) {
    const key = preset.name.toLowerCase();
    if (listed.has(key)) continue;
    listed.add(key);
    added.push({ id: randomUUID(), name: preset.name, website: preset.website, searchUrl: "", nameSearchUrl: "", createdAt: now, createdBy: author });
  }
  return added;
}
