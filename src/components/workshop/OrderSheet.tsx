import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckSquare, ClipboardCopy, MessageCircle, Printer, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Supplier, User, Vehicle, WorkshopRecord } from "@/lib/workshop-types";
import { toast } from "sonner";

/*
 * A parts order, not a stored record: the parts already on the vehicle are
 * ticked, given a quantity, and printed or pasted into WhatsApp for the
 * supplier. Nothing is saved, so a sheet can be made for one phone call and
 * thrown away. It is rendered onto <body> like the job sheet so the print
 * stylesheet can keep the application off the paper.
 */

type Line = { part: WorkshopRecord; qty: number; supplier: string };
type Picked = Record<string, { on: boolean; qty: string }>;

function vehicleTitle(vehicle: Vehicle) {
  return `${vehicle.make} ${vehicle.model} ${vehicle.year}`.replace(/\s+/g, " ").trim() || "Vehicle";
}

function noteOf(part: WorkshopRecord) {
  return (part.content || "").replace(/\s+/g, " ").trim();
}

function quantity(value: string) {
  const qty = Math.floor(Number(value));
  return Number.isFinite(qty) && qty > 0 ? Math.min(qty, 99) : 1;
}

/** Parts gather under the supplier that will be called, unsupplied ones last. */
function bySupplier(lines: Line[]) {
  const sorted = [...lines].sort((a, b) =>
    (a.supplier || "~").localeCompare(b.supplier || "~") || a.part.title.localeCompare(b.part.title));
  const groups = new Map<string, Line[]>();
  for (const line of sorted) groups.set(line.supplier, [...(groups.get(line.supplier) || []), line]);
  return [...groups.entries()].map(([supplier, items]) => ({ supplier, items }));
}

function orderText(workshop: string, vehicle: Vehicle, lines: Line[]) {
  const out = [`Parts order — ${vehicleTitle(vehicle)}`];
  if (vehicle.registration) out.push(`Reg ${vehicle.registration}`);
  if (vehicle.vin) out.push(`VIN ${vehicle.vin}`);
  for (const group of bySupplier(lines)) {
    out.push("", group.supplier || "Supplier to confirm");
    for (const { part, qty } of group.items) {
      const note = noteOf(part);
      out.push(`• ${qty} × ${part.partNumber || "number to confirm"} — ${part.title}${part.partMake ? ` (${part.partMake})` : ""}${note ? ` · ${note.slice(0, 100)}` : ""}`);
    }
  }
  out.push("", `From ${workshop || "our workshop"}`);
  return out.join("\n");
}

export default function OrderSheet({ workshop, user, vehicle, parts, suppliers, close }: {
  workshop: string;
  user: User | null;
  vehicle: Vehicle;
  parts: WorkshopRecord[];
  suppliers: Supplier[];
  close: () => void;
}) {
  const [picked, setPicked] = useState<Picked>(() => Object.fromEntries(parts.map(part => [part.id, { on: true, qty: "1" }])));
  const message = useRef<HTMLTextAreaElement | null>(null);
  const supplierOf = (id?: string) => suppliers.find(supplier => supplier.id === id)?.name || "";
  const lines: Line[] = parts
    .filter(part => picked[part.id]?.on)
    .map(part => ({ part, qty: quantity(picked[part.id]?.qty ?? "1"), supplier: supplierOf(part.supplierId) }));
  const text = lines.length ? orderText(workshop, vehicle, lines) : "";
  const printed = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  function toggle(part: WorkshopRecord) {
    setPicked(current => ({ ...current, [part.id]: { ...current[part.id], on: !current[part.id]?.on } }));
  }

  function setQty(part: WorkshopRecord, qty: string) {
    setPicked(current => ({ ...current, [part.id]: { ...current[part.id], on: true, qty } }));
  }

  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Order copied — paste it into WhatsApp");
    } catch {
      // A workshop server on the LAN is not a secure context, so the clipboard
      // API can be missing; selecting the message is the next best thing.
      message.current?.focus();
      message.current?.select();
      toast.info("Message selected — press Ctrl+C to copy it");
    }
  }

  return createPortal(
    <div className="print-overlay">
      <div className="no-print sticky top-0 z-10 mx-auto mb-4 flex max-w-[210mm] flex-wrap items-center justify-between gap-3 rounded-lg bg-neutral-900/95 px-3 py-2 text-white shadow-lg">
        <p className="text-xs font-medium">Parts order · {vehicleTitle(vehicle)} · {lines.length} item{lines.length === 1 ? "" : "s"}</p>
        <div className="flex flex-wrap gap-2">
          <a
            href={text ? `https://wa.me/?text=${encodeURIComponent(text)}` : undefined}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!text}
            className={`flex h-9 items-center rounded-lg px-3 text-xs font-semibold ${text ? "text-white/90 hover:bg-white/10" : "pointer-events-none text-white/40"}`}
          >
            <MessageCircle size={15} className="mr-2" />WhatsApp
          </a>
          <Button variant="secondary" disabled={!text} onClick={copy} className="h-9 rounded-lg text-xs font-semibold">
            <ClipboardCopy size={15} className="mr-2" />Copy message
          </Button>
          <Button variant="secondary" disabled={!text} onClick={() => window.print()} className="h-9 rounded-lg text-xs font-semibold">
            <Printer size={15} className="mr-2" />Print
          </Button>
          <Button variant="ghost" onClick={close} className="h-9 rounded-lg text-xs text-white hover:bg-white/10">
            <X size={15} className="mr-2" />Close
          </Button>
        </div>
      </div>

      <div className="no-print mx-auto mb-4 max-w-[210mm] rounded-xl border border-border bg-white p-5 shadow-xl">
        <p className="text-xs font-semibold">Choose the parts to order</p>
        <p className="mt-1 text-[11px] leading-5 text-muted-foreground">Untick anything the supplier does not need to quote. Quantities go on both the message and the printed sheet.</p>
        <div className="mt-3 divide-y divide-border/70 border-y border-border/70">
          {parts.map(part => {
            const row = picked[part.id];
            return (
              <div key={part.id} className="flex items-center gap-3 py-2">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={Boolean(row?.on)}
                  aria-label={`Include ${part.title}`}
                  onClick={() => toggle(part)}
                  className={row?.on ? "text-primary" : "text-muted-foreground"}
                >
                  {row?.on ? <CheckSquare size={17} /> : <Square size={17} />}
                </button>
                <Input
                  aria-label={`Quantity for ${part.title}`}
                  value={row?.qty ?? "1"}
                  onChange={event => setQty(part, event.target.value)}
                  inputMode="numeric"
                  maxLength={2}
                  className="h-8 w-14 rounded-lg border-border bg-white text-center text-xs"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{part.title}</p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {part.partNumber || "No part number"}{part.partMake ? ` · ${part.partMake}` : ""} · {supplierOf(part.supplierId) || "No supplier chosen"}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
        <label htmlFor="order-message" className="mt-4 block text-xs font-semibold">WhatsApp message</label>
        <textarea
          id="order-message"
          ref={message}
          readOnly
          rows={7}
          value={text}
          onFocus={event => event.currentTarget.select()}
          className="mt-2 w-full resize-y rounded-xl border border-border bg-background/60 p-3 font-mono text-[11px] leading-5 text-foreground"
        />
      </div>

      <div className="print-sheet">
        <div className="flex items-start justify-between gap-6 border-b border-neutral-300 pb-4">
          <div>
            <h1 className="font-heading text-[20px] font-bold leading-tight text-black">{workshop || "My workshop"}</h1>
            <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-neutral-500">Parts order</p>
          </div>
          <div className="text-right text-[10px] leading-5 text-neutral-600">
            <p className="font-semibold uppercase tracking-[0.1em] text-black">{vehicleTitle(vehicle)}</p>
            {vehicle.registration && <p>{vehicle.registration}</p>}
            {vehicle.vin && <p>VIN {vehicle.vin}</p>}
            <p>Printed {printed}</p>
            {user && <p>By {user.name}</p>}
          </div>
        </div>

        {lines.length === 0 && <p className="mt-6 text-[11px] text-neutral-600">No parts are ticked for this order.</p>}

        {bySupplier(lines).map(group => (
          <section key={group.supplier || "unsupplied"} className="mt-5">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.1em] text-black">{group.supplier || "Supplier to confirm"}</h2>
            <table className="mt-2 w-full border-collapse text-left text-[10px]">
              <thead>
                <tr className="border-b border-neutral-400 text-[9px] uppercase tracking-[0.08em] text-neutral-500">
                  <th className="w-[7%] py-2 pr-3 font-semibold">Qty</th>
                  <th className="w-[22%] py-2 pr-3 font-semibold">Part number</th>
                  <th className="w-[35%] py-2 pr-3 font-semibold">Description</th>
                  <th className="py-2 font-semibold">Notes</th>
                </tr>
              </thead>
              <tbody>
                {group.items.map(({ part, qty }) => (
                  <tr key={part.id} className="keep border-b border-neutral-200 align-top">
                    <td className="py-2 pr-3 font-semibold text-black">{qty}</td>
                    <td className="break-all py-2 pr-3 font-mono text-[9px] text-neutral-800">{part.partNumber || "—"}</td>
                    <td className="py-2 pr-3 text-neutral-800">{part.title}{part.partMake ? ` · ${part.partMake}` : ""}</td>
                    <td className="py-2 text-neutral-600">{noteOf(part) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}

        <div className="mt-8 flex gap-10">
          <div className="flex-1"><div className="h-8 border-b border-neutral-400" /><p className="mt-1 text-[9px] uppercase tracking-[0.1em] text-neutral-500">Ordered by</p></div>
          <div className="w-40"><div className="h-8 border-b border-neutral-400" /><p className="mt-1 text-[9px] uppercase tracking-[0.1em] text-neutral-500">Date</p></div>
        </div>

        <p className="mt-6 border-t border-neutral-200 pt-2 text-[8px] leading-4 text-neutral-400">
          {workshop || "My workshop"} · Numbers are as recorded in Workshop Atlas. Confirm stock, price and superseded numbers with the supplier.
        </p>
      </div>
    </div>,
    document.body,
  );
}
