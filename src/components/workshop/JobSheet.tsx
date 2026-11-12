import { useState } from "react";
import { createPortal } from "react-dom";
import { CheckSquare, Printer, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { prettyDate } from "./primitives";
import type { User, Vehicle, WorkshopRecord } from "@/lib/workshop-types";

/*
 * A sheet meant for paper: the customer takes away what was done and what it
 * took, and the workshop keeps the same page with the job card. It is rendered
 * straight onto <body> rather than inside the dialog it was opened from, so the
 * print stylesheet can hide the application and leave only this page.
 */

function formatMinutes(minutes: number) {
  if (!minutes) return "—";
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;
}

function Label({ children }: { children: string }) {
  return <dt className="text-[9px] font-semibold uppercase tracking-[0.08em] text-neutral-500">{children}</dt>;
}

export default function JobSheet({ workshop, user, vehicle, entry, history, close }: {
  workshop: string;
  user: User | null;
  vehicle: Vehicle;
  /** One service entry: prints as a job sheet. */
  entry?: WorkshopRecord;
  /** All service entries: prints as a service history. */
  history?: WorkshopRecord[];
  close: () => void;
}) {
  const rows = entry ? [entry] : history || [];
  const total = rows.reduce((sum, row) => sum + (row.repairTimeMinutes || 0), 0);
  // The reference page is opt-in: a customer sheet usually stops at the work
  // performed, while the copy kept with the job card wants the times and torques.
  const [extras, setExtras] = useState(false);
  const repairTimes = vehicle.repairTimes || [];
  const torques = vehicle.torqueSpecs || [];
  const hasExtras = repairTimes.length > 0 || torques.length > 0;
  const printed = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const title = vehicle.make || vehicle.model ? `${vehicle.make} ${vehicle.model}`.trim() : "Vehicle";

  const details: [string, string][] = [
    ["Registration", vehicle.registration],
    ["VIN", vehicle.vin],
    ["Year", vehicle.year],
    ["Engine / variant", vehicle.engine],
    ["Engine model", vehicle.engineModel],
    ["Engine number", vehicle.engineNumber],
    ["Colour", vehicle.colour],
    ["Licence number", vehicle.licenceNumber],
    ["Licence expiry", vehicle.expiry],
    ["Customer / owner", vehicle.customer],
  ];

  return createPortal(
    <div className="print-overlay">
      <div className="no-print sticky top-0 z-10 mx-auto mb-4 flex max-w-[210mm] flex-wrap items-center justify-between gap-3 rounded-lg bg-neutral-900/95 px-3 py-2 text-white shadow-lg">
        <p className="text-xs font-medium">{entry ? "Job sheet" : "Service history"} · {title}</p>
        {hasExtras && (
          <button
            type="button"
            aria-pressed={extras}
            onClick={() => setExtras(open => !open)}
            className="flex items-center gap-2 rounded-lg px-2 py-1 text-[11px] font-medium text-white/90 hover:bg-white/10"
          >
            {extras ? <CheckSquare size={14} /> : <Square size={14} />}
            Add repair times &amp; torques
          </button>
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => window.print()} className="h-9 rounded-lg text-xs font-semibold">
            <Printer size={15} className="mr-2" />Print
          </Button>
          <Button variant="ghost" onClick={close} className="h-9 rounded-lg text-xs text-white hover:bg-white/10">
            <X size={15} className="mr-2" />Close
          </Button>
        </div>
      </div>

      <div className="print-sheet">
        <div className="flex items-start justify-between gap-6 border-b border-neutral-300 pb-4">
          <div>
            <h1 className="font-heading text-[20px] font-bold leading-tight text-black">{workshop || "My workshop"}</h1>
            <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-neutral-500">{entry ? "Job sheet" : "Service history"}</p>
          </div>
          <div className="text-right text-[10px] leading-5 text-neutral-600">
            <p className="font-semibold uppercase tracking-[0.1em] text-black">{title}</p>
            <p>Printed {printed}</p>
            {user && <p>By {user.name}</p>}
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-x-6 gap-y-3">
          {details.filter(([, value]) => value).map(([label, value]) => (
            <div key={label} className="min-w-0">
              <Label>{label}</Label>
              <dd className="mt-0.5 break-words text-[11px] font-medium text-black">{value}</dd>
            </div>
          ))}
        </dl>

        {entry ? (
          <>
            <dl className="mt-5 grid grid-cols-3 gap-6 border-y border-neutral-300 py-3">
              <div><Label>Service date</Label><dd className="mt-0.5 text-[11px] font-semibold text-black">{entry.date ? prettyDate(entry.date) : "—"}</dd></div>
              <div><Label>Odometer</Label><dd className="mt-0.5 text-[11px] font-semibold text-black">{entry.mileage || "—"}</dd></div>
              <div><Label>Repair time</Label><dd className="mt-0.5 text-[11px] font-semibold text-black">{formatMinutes(entry.repairTimeMinutes)}</dd></div>
            </dl>
            <div className="mt-4 keep">
              <h2 className="text-[11px] font-bold uppercase tracking-[0.1em] text-black">{entry.title || "Work performed"}</h2>
              <p className="mt-2 whitespace-pre-wrap text-[11px] leading-[1.7] text-neutral-800">{entry.content}</p>
            </div>
          </>
        ) : (
          <div className="mt-5">
            <table className="w-full border-collapse text-left text-[10px]">
              <thead>
                <tr className="border-b border-neutral-400 text-[9px] uppercase tracking-[0.08em] text-neutral-500">
                  <th className="w-[16%] py-2 pr-3 font-semibold">Date</th>
                  <th className="w-[12%] py-2 pr-3 font-semibold">Odometer</th>
                  <th className="py-2 pr-3 font-semibold">Work performed</th>
                  <th className="w-[12%] py-2 text-right font-semibold">Time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className="keep border-b border-neutral-200 align-top">
                    <td className="py-2.5 pr-3 text-neutral-700">{row.date ? prettyDate(row.date) : prettyDate(row.updatedAt)}</td>
                    <td className="py-2.5 pr-3 text-neutral-700">{row.mileage || "—"}</td>
                    <td className="py-2.5 pr-3">
                      <p className="font-semibold text-black">{row.title}</p>
                      {row.content && <p className="mt-1 whitespace-pre-wrap leading-[1.6] text-neutral-700">{row.content}</p>}
                    </td>
                    <td className="py-2.5 text-right font-semibold text-black">{formatMinutes(row.repairTimeMinutes)}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={4} className="py-4 text-neutral-500">No service entries recorded yet.</td></tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-neutral-400">
                  <td colSpan={3} className="py-2.5 text-[10px] font-semibold text-black">
                    {rows.length} visit{rows.length === 1 ? "" : "s"}
                  </td>
                  <td className="py-2.5 text-right text-[10px] font-bold text-black">{formatMinutes(total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <div className="mt-8 flex gap-10">
          <div className="flex-1"><div className="h-8 border-b border-neutral-400" /><p className="mt-1 text-[9px] uppercase tracking-[0.1em] text-neutral-500">Technician</p></div>
          <div className="flex-1"><div className="h-8 border-b border-neutral-400" /><p className="mt-1 text-[9px] uppercase tracking-[0.1em] text-neutral-500">Customer</p></div>
        </div>

        <p className="mt-6 border-t border-neutral-200 pt-2 text-[8px] leading-4 text-neutral-400">
          {workshop || "My workshop"} · Printed from Workshop Atlas. Times are workshop allowances; check safety-critical specifications against an authorised source.
        </p>
      </div>

      {extras && hasExtras && (
        <div className="print-sheet mt-4">
          <div className="flex items-start justify-between gap-6 border-b border-neutral-300 pb-3">
            <div>
              <h2 className="font-heading text-[17px] font-bold leading-tight text-black">{workshop || "My workshop"}</h2>
              <p className="mt-1 text-[9px] uppercase tracking-[0.14em] text-neutral-500">Reference · {entry ? "job sheet" : "service history"}</p>
            </div>
            <div className="text-right text-[10px] leading-5 text-neutral-600">
              <p className="font-semibold uppercase tracking-[0.1em] text-black">{title}</p>
              {vehicle.registration && <p>{vehicle.registration}</p>}
              {vehicle.vin && <p>VIN {vehicle.vin}</p>}
            </div>
          </div>

          {repairTimes.length > 0 && (
            <section className="mt-4">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-black">Repair times ({repairTimes.length})</h3>
              <table className="mt-2 w-full border-collapse text-left text-[10px]">
                <thead>
                  <tr className="border-b border-neutral-400 text-[9px] uppercase tracking-[0.08em] text-neutral-500">
                    <th className="py-2 pr-3 font-semibold">Operation</th>
                    <th className="w-[18%] py-2 pr-3 font-semibold">Scope</th>
                    <th className="w-[14%] py-2 text-right font-semibold">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {repairTimes.map((item, index) => (
                    <tr key={`${item.operation}-${index}`} className="keep border-b border-neutral-200 align-top">
                      <td className="py-2 pr-3 text-neutral-800">{item.operation}</td>
                      <td className="py-2 pr-3 text-neutral-600">{item.scope || "—"}</td>
                      <td className="whitespace-nowrap py-2 text-right font-semibold text-black">{formatMinutes(item.minutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1.5 text-[8px] text-neutral-400">
                Workshop allowances{vehicle.repairTimesSource ? ` · ${vehicle.repairTimesSource}` : ""}{vehicle.repairTimesUpdatedAt ? ` · updated ${prettyDate(vehicle.repairTimesUpdatedAt)}` : ""}.
              </p>
            </section>
          )}

          {torques.length > 0 && (
            <section className="mt-5">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-black">Tightening torques ({torques.length})</h3>
              <table className="mt-2 w-full border-collapse text-left text-[10px]">
                <thead>
                  <tr className="border-b border-neutral-400 text-[9px] uppercase tracking-[0.08em] text-neutral-500">
                    <th className="py-2 pr-3 font-semibold">Fastener</th>
                    <th className="w-[18%] py-2 pr-3 font-semibold">Stage</th>
                    <th className="w-[16%] py-2 text-right font-semibold">Torque</th>
                  </tr>
                </thead>
                <tbody>
                  {torques.map((spec, index) => (
                    <tr key={`${spec.fastener}-${spec.stage}-${index}`} className="keep border-b border-neutral-200 align-top">
                      <td className="py-2 pr-3 text-neutral-800">{spec.fastener}</td>
                      <td className="py-2 pr-3 text-neutral-600">{spec.stage ? `Stage ${spec.stage}` : "—"}</td>
                      <td className="whitespace-nowrap py-2 text-right font-semibold text-black">{spec.value} {spec.unit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1.5 text-[8px] text-neutral-400">
                Verify tightening torques against the manufacturer's current data before use.
              </p>
            </section>
          )}

          <p className="mt-6 border-t border-neutral-200 pt-2 text-[8px] leading-4 text-neutral-400">
            {workshop || "My workshop"} · Reference page · Printed {printed}
          </p>
        </div>
      )}
    </div>,
    document.body,
  );
}
