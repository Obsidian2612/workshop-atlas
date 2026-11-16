import type { Vehicle, WorkshopRecord } from "./workshop-types";

/*
 * The wording of a parts order lives apart from the screen that shows it: the
 * WhatsApp message, the supplier grouping and the printed columns all read from
 * these, so the message and the paper say the same thing.
 */

export type OrderLine = { part: WorkshopRecord; qty: number; supplier: string };
export type OrderGroup = { supplier: string; items: OrderLine[] };

export const vehicleTitle = (vehicle: Vehicle) =>
  `${vehicle.make} ${vehicle.model} ${vehicle.year}`.replace(/\s+/g, " ").trim() || "Vehicle";

export const noteOf = (part: WorkshopRecord) => (part.content || "").replace(/\s+/g, " ").trim();

/** Named suppliers first in alphabetical order, then the parts with none. */
const supplierOrder = (a: string, b: string) => !a ? (b ? 1 : 0) : !b ? -1 : a.localeCompare(b);

/** Quantity boxes take digits only, so an empty box means one. */
export const quantity = (value: string) => Math.max(1, Number(value) || 1);

/** A note long enough to swamp a WhatsApp line is cut at a word. */
export function shortNote(note: string) {
  if (note.length <= 90) return note;
  const cut = note.slice(0, 90);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40))}…`;
}

/** Parts gather under the supplier that will be called, those without one last. */
export function bySupplier(lines: OrderLine[]): OrderGroup[] {
  const sorted = [...lines].sort((a, b) =>
    supplierOrder(a.supplier, b.supplier) || a.part.title.localeCompare(b.part.title));
  const groups = new Map<string, OrderLine[]>();
  for (const line of sorted) groups.set(line.supplier, [...(groups.get(line.supplier) || []), line]);
  return [...groups.entries()].map(([supplier, items]) => ({ supplier, items }));
}

export function orderText(workshop: string, vehicle: Vehicle, groups: OrderGroup[], total: number) {
  const out = [`Parts order — ${vehicleTitle(vehicle)}`];
  if (vehicle.registration) out.push(`Reg ${vehicle.registration}`);
  if (vehicle.vin) out.push(`VIN ${vehicle.vin}`);
  for (const group of groups) {
    out.push("", group.supplier || "Supplier to confirm");
    for (const { part, qty } of group.items) {
      const note = shortNote(noteOf(part));
      out.push(`• ${qty} × ${part.partNumber || "number to confirm"} — ${part.title}${part.partMake ? ` (${part.partMake})` : ""}${note ? ` · ${note}` : ""}`);
    }
  }
  out.push("", `${total} item${total === 1 ? "" : "s"} · ${workshop || "our workshop"}`);
  return out.join("\n");
}
