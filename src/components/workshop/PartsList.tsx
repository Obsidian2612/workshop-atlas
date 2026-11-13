import { ExternalLink, Package, Search } from "lucide-react";
import type { Supplier, Vehicle, WorkshopRecord, Workspace } from "@/lib/workshop-types";
import { partQuery, supplierSearchUrl, vehicleQuery, webSearchUrl } from "@/lib/supplier-search";
import type { DetailTarget } from "./RecordDetail";

/*
 * One row per part: the number and make to quote, the vehicle it fits and who
 * sells it. The search buttons open that supplier's own catalogue, narrowed to
 * this part and vehicle, so the counter can check stock without retyping.
 */
export default function PartsList({ parts, data, view }: { parts: WorkshopRecord[]; data: Workspace; view: (target: DetailTarget) => void }) {
  const supplierOf = (part: WorkshopRecord) => data.suppliers.find(supplier => supplier.id === part.supplierId);
  const vehicleOf = (part: WorkshopRecord) => data.vehicles.find(vehicle => vehicle.id === part.vehicleId);
  // The part's own supplier comes first; the rest of the list is still one click away.
  const searchTargets = (part: WorkshopRecord): Supplier[] => {
    const own = supplierOf(part);
    return [...(own ? [own] : []), ...data.suppliers.filter(supplier => supplier.id !== own?.id)].slice(0, 3);
  };
  return <div className="space-y-3">{parts.map(part => {
    const supplier = supplierOf(part);
    const vehicle = vehicleOf(part);
    const query = partQuery(part, vehicle);
    // Catalogue sites match text, so they get the number (or the name) alone.
    const catalogueQuery = part.partNumber || part.title;
    return <div key={part.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-white p-4 transition-colors hover:border-primary/30">
      <button onClick={() => view({ entity: "record", id: part.id })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="shrink-0 rounded-xl bg-primary/5 p-3 text-primary"><Package size={20} strokeWidth={1.6} /></span>
        <div className="min-w-0">
          <p className="truncate font-heading text-sm font-bold">{part.title}</p>
          <p className="mt-1 truncate font-mono text-xs text-foreground">
            {part.partNumber || <span className="font-sans text-muted-foreground">No part number</span>}
            {part.partMake && <span className="ml-2 rounded bg-background px-1.5 py-0.5 font-sans text-[10px] font-semibold text-muted-foreground">{part.partMake}</span>}
          </p>
          <p className="mt-1 truncate text-[10px] text-muted-foreground">
            {vehicle ? `${vehicle.make} ${vehicle.model}${vehicle.registration ? ` · ${vehicle.registration}` : vehicle.year ? ` · ${vehicle.year}` : ""}` : "Not linked to a vehicle"}
            {supplier ? "" : " · No supplier chosen"}
          </p>
        </div>
      </button>
      <div className="flex flex-wrap items-center gap-1.5">
        {data.suppliers.length === 0 && <span className="text-[10px] text-muted-foreground">Add a supplier in Settings to search their site</span>}
        {searchTargets(part).map(target => <a key={target.id} href={supplierSearchUrl(target, query, catalogueQuery, vehicle?.vin)} target="_blank" rel="noreferrer noopener" title={`Search ${target.name} for “${query}”`} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/5">
          <Search size={12} />{target.name}
        </a>)}
        {supplier && <a href={supplier.website} target="_blank" rel="noreferrer noopener" aria-label={`Open ${supplier.name} website`} title={supplier.website} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background hover:text-primary"><ExternalLink size={14} /></a>}
        {vehicle && vehicle.vin && <a href={webSearchUrl(`${part.partNumber || part.title} ${vehicleQuery(vehicle, "vin")}`)} target="_blank" rel="noreferrer noopener" title={`Look up this part against VIN ${vehicle.vin}`} className="inline-flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1.5 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/15">
          Search by VIN
        </a>}
      </div>
    </div>;
  })}</div>;
}
