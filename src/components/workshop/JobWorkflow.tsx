import { useState } from "react";
import { ArrowRight, CarFront, ClipboardList, Clock3, FileText, Globe, Loader2, Package, Plus, Printer, Search, ShieldAlert, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/workshop-api";
import type { RepairTimeEntry, TorqueSpec, Vehicle, VinLookupResult, WorkshopRecord, Workspace } from "@/lib/workshop-types";
import { EmptyState, Panel, Pick, prettyDate } from "./primitives";
import type { EditorTarget } from "./RecordEditor";
import type { DetailTarget } from "./RecordDetail";
import RepairTimeList from "./RepairTimeList";
import ManualRepairTimes from "./ManualRepairTimes";
import GroqRepairTimes from "./GroqRepairTimes";
import TorqueSearch from "./TorqueSearch";
import TorqueCheck from "./TorqueCheck";
import PasteTimes from "./PasteTimes";
import PartsSearch from "./PartsSearch";
import OrderSheet from "./OrderSheet";
import JobSheet from "./JobSheet";
import { toast } from "sonner";

/*
 * The day's job, in the order it actually happens: identify the vehicle, agree
 * the time, find the torques, source the parts, then sign the visit off. Every
 * step writes to the same vehicle record the rest of the app uses, so a job
 * started here can be continued in the vehicle library and vice versa.
 */

const formatMinutes = (minutes: number) =>
  minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;

function Step({ number, title, state, children, actions }: {
  number: number;
  title: string;
  state: "done" | "open" | "empty";
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return <Panel className="overflow-hidden">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 px-5 py-4 sm:px-6">
      <div className="flex items-center gap-3">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${state === "done" ? "bg-primary text-white" : state === "open" ? "bg-amber-100 text-amber-800" : "border border-border bg-background text-muted-foreground"}`}>
          {state === "done" ? <ShieldCheck size={14} /> : state === "open" ? <ShieldAlert size={14} /> : number}
        </span>
        <div><p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-muted-foreground">Step {number}</p><h2 className="font-heading text-base font-bold tracking-tight">{title}</h2></div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
    <div className="px-5 py-4 sm:px-6">{children}</div>
  </Panel>;
}

function Action({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
  return <button onClick={onClick} className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/80">{icon}{label}</button>;
}

export default function JobWorkflow({ data, create, view, refresh }: {
  data: Workspace;
  create: (target: EditorTarget) => void;
  view: (target: DetailTarget) => void;
  refresh: () => Promise<void>;
}) {
  const [vehicleId, setVehicleId] = useState(data.vehicles[0]?.id || "");
  const [timesOpen, setTimesOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualEntry, setManualEntry] = useState<RepairTimeEntry | undefined>(undefined);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [torqueSearchOpen, setTorqueSearchOpen] = useState(false);
  const [checkTarget, setCheckTarget] = useState<TorqueSpec | null>(null);
  const [partsOpen, setPartsOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [sheetEntry, setSheetEntry] = useState<WorkshopRecord | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [vinBusy, setVinBusy] = useState(false);

  const vehicle: Vehicle | undefined = data.vehicles.find(item => item.id === vehicleId) || data.vehicles[0];
  const canEdit = Boolean(data.user && data.user.role !== "viewer");

  if (!vehicle) return <EmptyState
    title="Start with the vehicle on the bench"
    description="Pick a vehicle and the day's work follows in order: identification, repair time, torques, parts and the job sheet."
    action={data.user && canEdit ? { label: "Add a vehicle", onClick: () => create({ entity: "vehicle" }) } : undefined}
  />;

  const repairTimes = vehicle.repairTimes || [];
  const torques = vehicle.torqueSpecs || [];
  const unchecked = torques.filter(spec => !spec.checkedAt).length;
  const parts = data.records.filter(record => record.kind === "part" && record.vehicleId === vehicle.id);
  const visits = data.records.filter(record => record.kind === "service" && record.vehicleId === vehicle.id);
  const allowance = repairTimes.reduce((sum, entry) => sum + entry.minutes, 0);
  const identified = Boolean(vehicle.make.trim() && vehicle.model.trim() && (vehicle.vin.trim() || vehicle.registration.trim()));
  const ready = [identified, repairTimes.length > 0, torques.length > 0 && unchecked === 0, parts.length > 0, visits.length > 0].filter(Boolean).length;

  // Identification only fills what is blank and saves it; nothing already recorded is replaced.
  async function fillFromVin() {
    setVinBusy(true);
    try {
      const result = await api<VinLookupResult>("vin-lookup", { vin: vehicle.vin });
      const next = { make: vehicle.make, model: vehicle.model, year: vehicle.year, engine: vehicle.engine, engineModel: vehicle.engineModel };
      const filled: string[] = [];
      for (const field of ["make", "model", "year", "engine", "engineModel"] as const) {
        const text = result.fields[field];
        if (!text || next[field].trim()) continue;
        next[field] = text;
        filled.push(field === "engineModel" ? "engine model" : field);
      }
      if (!filled.length) { toast.info("Nothing this VIN could confirm was missing."); return; }
      await api("records", {
        action: "save", entity: "vehicle", id: vehicle.id, kind: "vehicle", vehicleId: "",
        ...next, engineNumber: vehicle.engineNumber || "", registration: vehicle.registration || "",
        licenceNumber: vehicle.licenceNumber || "", colour: vehicle.colour || "", expiry: vehicle.expiry || "",
        vin: vehicle.vin, customer: vehicle.customer || "", specifications: vehicle.specifications || "",
      });
      await refresh();
      toast.success(`Filled ${filled.join(", ")} from the VIN`);
    } catch (error) { toast.error((error as Error).message); }
    finally { setVinBusy(false); }
  }

  return <div className="space-y-5">
    <Panel className="overflow-hidden">
      <div className="flex flex-col gap-4 p-5 sm:p-6 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#f0f4f1] text-primary"><CarFront size={22} strokeWidth={1.5} /></span>
          <div className="min-w-0 flex-1">
            <Pick label="Vehicle on the bench" value={vehicle.id} onChange={setVehicleId} options={data.vehicles.map(item => ({ value: item.id, label: `${item.make} ${item.model}${item.registration ? ` · ${item.registration}` : item.year ? ` · ${item.year}` : ""}` }))} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 text-center lg:w-[330px]">
          <div className="rounded-xl border border-border bg-background/60 px-2 py-2.5"><p className="font-heading text-base font-bold leading-none">{formatMinutes(allowance)}</p><p className="mt-1.5 text-[10px] text-muted-foreground">Allowance</p></div>
          <div className="rounded-xl border border-border bg-background/60 px-2 py-2.5"><p className={`font-heading text-base font-bold leading-none ${unchecked ? "text-amber-700" : "text-primary"}`}>{unchecked ? unchecked : torques.length}</p><p className="mt-1.5 text-[10px] text-muted-foreground">{unchecked ? "Torques unchecked" : "Torques ready"}</p></div>
          <div className="rounded-xl border border-border bg-background/60 px-2 py-2.5"><p className="font-heading text-base font-bold leading-none">{parts.length}</p><p className="mt-1.5 text-[10px] text-muted-foreground">Parts</p></div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/70 px-5 py-3 sm:px-6">
        <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-muted-foreground">{ready} of 5 steps ready</p>
        <div className="flex flex-1 items-center gap-1" aria-hidden="true">{[0, 1, 2, 3, 4].map(step => <span key={step} className={`h-1.5 flex-1 rounded-full ${step < ready ? "bg-primary" : "bg-border"}`} />)}</div>
        <button onClick={() => view({ entity: "vehicle", id: vehicle.id })} className="flex items-center gap-1 text-xs font-semibold text-primary">Open the full record <ArrowRight size={13} /></button>
      </div>
    </Panel>

    <Step number={1} title="Identify the vehicle" state={identified ? "done" : "open"}
      actions={<>
        {!identified && canEdit && <Action label="Edit the vehicle" icon={<Plus size={13} />} onClick={() => create({ entity: "vehicle", value: vehicle })} />}
        {vehicle.vin.trim() ? (canEdit && <Action label={vinBusy ? "Reading the VIN…" : "Fill missing details from the VIN"} icon={vinBusy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} onClick={() => { if (!vinBusy) void fillFromVin(); }} />) : null}
      </>}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {([["Registration", vehicle.registration], ["VIN", vehicle.vin], ["Year / engine", [vehicle.year, vehicle.engine].filter(Boolean).join(" · ")], ["Customer", vehicle.customer]] as const).map(([label, value]) => <div key={label} className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p><p className={`mt-1 break-words text-xs ${value ? "font-medium" : "text-muted-foreground"}`}>{value || "Not recorded"}</p></div>)}
      </div>
      {!identified && !vehicle.vin.trim() && <p className="mt-3 text-[11px] leading-5 text-muted-foreground">A registration or a VIN is enough to find the vehicle again. Edit the record to add what is missing before relying on a lookup.</p>}
    </Step>

    <Step number={2} title="Agree the repair time" state={repairTimes.length ? "done" : "open"}
      actions={canEdit ? <>
        <Action label="Fetch times" icon={<Sparkles size={13} />} onClick={() => setTimesOpen(true)} />
        <Action label="Add a time" icon={<Plus size={13} />} onClick={() => { setManualEntry(undefined); setManualOpen(true); }} />
        <Action label="Paste from the program" icon={<FileText size={13} />} onClick={() => setPasteOpen(true)} />
      </> : undefined}>
      {repairTimes.length ? <>
        <RepairTimeList entries={repairTimes} canEdit={canEdit} formatMinutes={formatMinutes} onEdit={entry => { setManualEntry(entry); setManualOpen(true); }} />
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Clock3 size={12} />{repairTimes.length} operation{repairTimes.length === 1 ? "" : "s"} · {formatMinutes(allowance)} total allowance</p>
      </> : <p className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">No times recorded for this vehicle. Fetch a sheet, add one operation by hand, or paste the rows from the program you already use.</p>}
    </Step>

    <Step number={3} title="Check the tightening torques" state={!torques.length ? "empty" : unchecked ? "open" : "done"}
      actions={canEdit ? <>
        <Action label="Search online" icon={<Globe size={13} />} onClick={() => setTorqueSearchOpen(true)} />
        <Action label="Edit torques" icon={<Wrench size={13} />} onClick={() => view({ entity: "vehicle", id: vehicle.id })} />
        <Action label="Paste a table" icon={<FileText size={13} />} onClick={() => setPasteOpen(true)} />
      </> : undefined}>
      {torques.length ? <>
        {unchecked > 0 && <div role="alert" className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-900"><ShieldAlert size={15} className="mt-0.5 shrink-0" /><p>{unchecked} of {torques.length} torques {unchecked === 1 ? "has" : "have"} not been checked against an authorised source. Check each one before a technician tightens a fastener from it.</p></div>}
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {torques.map((spec, index) => <div key={`${spec.fastener}-${spec.stage}-${index}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-xs">
            <div className="min-w-0 flex-1"><p className="break-words font-medium">{spec.fastener}</p>{spec.stage && <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Stage {spec.stage}</p>}</div>
            <span className="shrink-0 font-semibold text-primary">{spec.value} {spec.unit}</span>
            {spec.checkedAt
              ? <span className="flex shrink-0 items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700"><ShieldCheck size={11} />{spec.checkedBy} · {prettyDate(spec.checkedAt)}</span>
              : canEdit ? <button onClick={() => setCheckTarget(spec)} className="flex shrink-0 items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"><ShieldCheck size={11} />Mark checked</button> : <span className="flex shrink-0 items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"><ShieldAlert size={11} />Not checked</span>}
          </div>)}
        </div>
      </> : <p className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">No tightening torques on this vehicle yet. Search for the fasteners on this job, or paste the table from the program.</p>}
    </Step>

    <Step number={4} title="Source the parts" state={parts.length ? "done" : "open"}
      actions={<>
        {canEdit && <Action label="Search suppliers" icon={<Search size={13} />} onClick={() => setPartsOpen(true)} />}
        {canEdit && <Action label="Add a part" icon={<Plus size={13} />} onClick={() => create({ entity: "record", kind: "part", vehicleId: vehicle.id })} />}
        {parts.length > 0 && <Action label="Order sheet" icon={<ClipboardList size={13} />} onClick={() => setOrderOpen(true)} />}
      </>}>
      {parts.length ? <div className="space-y-2">{parts.map(part => <button key={part.id} onClick={() => view({ entity: "record", id: part.id })} className="flex w-full items-center gap-3 rounded-xl border border-border px-4 py-3 text-left hover:bg-background/60"><Package size={16} className="shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{part.title}</p><p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{part.partNumber || "No part number"}{part.partMake ? ` · ${part.partMake}` : ""}{data.suppliers.find(supplier => supplier.id === part.supplierId)?.name ? ` · ${data.suppliers.find(supplier => supplier.id === part.supplierId)?.name}` : ""}</p></div><ArrowRight size={13} className="shrink-0 text-muted-foreground" /></button>)}</div>
        : <p className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">No parts recorded for this vehicle. Search your suppliers for the number you need, or add a part you already know.</p>}
    </Step>

    <Step number={5} title="Sign the visit off" state={visits.length ? "done" : "open"}
      actions={canEdit ? <Action label="Log the visit" icon={<Plus size={13} />} onClick={() => create({ entity: "record", kind: "service", vehicleId: vehicle.id })} /> : undefined}>
      {visits.length ? <div className="space-y-2">
        {visits.slice(0, 3).map(entry => <div key={entry.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border px-4 py-3">
          <div className="min-w-0 flex-1"><button onClick={() => view({ entity: "record", id: entry.id })} className="block w-full truncate text-left text-xs font-semibold hover:text-primary">{entry.title || "Service visit"}</button><p className="mt-1 text-[10px] text-muted-foreground">{entry.date ? prettyDate(entry.date) : prettyDate(entry.updatedAt)}{entry.mileage ? ` · ${entry.mileage}` : ""}{entry.repairTimeMinutes ? ` · ${formatMinutes(entry.repairTimeMinutes)}` : ""}</p></div>
          <button onClick={() => setSheetEntry(entry)} className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-semibold text-primary"><Printer size={12} />Job sheet</button>
        </div>)}
        <div className="flex flex-wrap items-center gap-4 pt-1">
          <button onClick={() => setHistoryOpen(true)} className="flex items-center gap-1 text-xs font-semibold text-primary"><Printer size={13} />Print the service history</button>
          {data.attachments.some(file => file.recordId === vehicle.id) && <span className="text-[11px] text-muted-foreground">{data.attachments.filter(file => file.recordId === vehicle.id).length} file(s) attached to the vehicle</span>}
        </div>
      </div> : <p className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">No visit logged yet. Record what was done, the odometer and the time spent, then print the job sheet for the customer and the job card.</p>}
    </Step>

    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-white px-5 py-4">
      <p className="flex items-center gap-2 text-[11px] text-muted-foreground"><ShieldAlert size={14} className="shrink-0 text-amber-600" />Times and torques are workshop notes. Check safety-critical values against an authorised source.</p>
      <Button variant="outline" onClick={() => view({ entity: "vehicle", id: vehicle.id })} className="h-9 rounded-lg text-xs">Open {vehicle.make} {vehicle.model}</Button>
    </div>

    {timesOpen && <GroqRepairTimes vehicle={vehicle} close={() => setTimesOpen(false)} refresh={refresh} />}
    {manualOpen && <ManualRepairTimes vehicle={vehicle} data={data} entry={manualEntry} close={() => setManualOpen(false)} refresh={refresh} />}
    {pasteOpen && <PasteTimes data={data} defaultVehicleId={vehicle.id} close={() => setPasteOpen(false)} refresh={refresh} />}
    {torqueSearchOpen && <TorqueSearch vehicle={vehicle} close={() => setTorqueSearchOpen(false)} refresh={refresh} onPaste={() => { setTorqueSearchOpen(false); setPasteOpen(true); }} />}
    {checkTarget && <TorqueCheck vehicle={vehicle} spec={checkTarget} close={() => setCheckTarget(null)} refresh={refresh} />}
    {partsOpen && <PartsSearch data={data} term="" vehicleId={vehicle.id} close={() => setPartsOpen(false)} refresh={refresh} />}
    {orderOpen && <OrderSheet workshop={data.name} user={data.user} vehicle={vehicle} parts={parts} suppliers={data.suppliers} close={() => setOrderOpen(false)} />}
    {sheetEntry && <JobSheet workshop={data.name} user={data.user} vehicle={vehicle} entry={sheetEntry} close={() => setSheetEntry(null)} />}
    {historyOpen && <JobSheet workshop={data.name} user={data.user} vehicle={vehicle} history={visits} close={() => setHistoryOpen(false)} />}
  </div>;
}
