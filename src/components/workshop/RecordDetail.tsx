import { useState } from "react";
import { BookOpen, CarFront, Clock, Download, ExternalLink, Loader2, Package, Pencil, Plus, Printer, RefreshCw, Search, Sparkles, Trash2, FileText, Globe, Wrench } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, download } from "@/lib/workshop-api";
import { torqueUnits, type RepairTimeEntry, type TorqueUnit, type Vehicle, type VinLookupResult, type WorkshopRecord, type Workspace } from "@/lib/workshop-types";
import { fileSize, prettyDate } from "./primitives";
import TorqueSearch from "./TorqueSearch";
import GeminiSearch from "./GeminiSearch";
import PasteTimes from "./PasteTimes";
import GroqSpecs from "./GroqSpecs";
import GroqRepairTimes from "./GroqRepairTimes";
import ManualRepairTimes from "./ManualRepairTimes";
import RepairTimeList from "./RepairTimeList";
import type { EditorTarget } from "./RecordEditor";
import { toast } from "sonner";
import JobSheet from "./JobSheet";
import { supplierSearchUrl, vehicleQuery, webSearchUrl } from "@/lib/supplier-search";
export type DetailTarget = { entity: "vehicle" | "record"; id: string };
const vinLabels: Record<string, string> = { make: "make", model: "model", year: "year", engine: "engine / variant", engineModel: "engine model" };
type TorqueDraftRow = { fastener: string; stage: string; value: string; unit: TorqueUnit };

export default function RecordDetail({ target, data, close, edit, remove, upload, view, refresh }: { target: DetailTarget; data: Workspace; close: () => void; edit: (target: EditorTarget) => void; remove: (entity: string, id: string, title: string) => void; upload: (id: string) => void; view: (target: DetailTarget) => void; refresh: () => Promise<void> }) {
  const [refreshing, setRefreshing] = useState(false);
  const [torqueDraft, setTorqueDraft] = useState<TorqueDraftRow[] | null>(null);
  const [torqueBusy, setTorqueBusy] = useState(false);
  const [torqueError, setTorqueError] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [pasteTorqueOpen, setPasteTorqueOpen] = useState(false);
  const [geminiOpen, setGeminiOpen] = useState(false);
  const [groqSpecsOpen, setGroqSpecsOpen] = useState(false);
  const [groqTimesOpen, setGroqTimesOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualEdit, setManualEdit] = useState<RepairTimeEntry | undefined>(undefined);
  const [vinBusy, setVinBusy] = useState(false);
  const [vinNote, setVinNote] = useState("");
  const [vinError, setVinError] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const item = target.entity === "vehicle" ? data.vehicles.find(v => v.id === target.id) : data.records.find(r => r.id === target.id);
  if (!item) return null;
  const vehicle = target.entity === "vehicle" ? item as Vehicle : data.vehicles.find(v => v.id === (item as WorkshopRecord).vehicleId);
  const record = target.entity === "record" ? item as WorkshopRecord : undefined;
  const title = record?.title || `${vehicle.make} ${vehicle.model}`;
  // Parts have their own panel below, so they are not repeated as linked records.
  const linkedRecords = target.entity === "vehicle" ? data.records.filter(r => r.vehicleId === item.id && r.kind !== "part") : [];
  // Resolved from the vehicle, so it is also right when the dialog was opened from a part.
  const vehicleParts = vehicle ? data.records.filter(r => r.kind === "part" && r.vehicleId === vehicle.id) : [];
  const files = data.attachments.filter(a => a.recordId === item.id);
  const canEdit = Boolean(data.user && data.user.role !== "viewer");
  const serviceRecords = linkedRecords.filter(r => r.kind === "service");
  const partSupplier = record ? data.suppliers.find(supplier => supplier.id === record.supplierId) : undefined;
  const totalRepairMinutes = serviceRecords.reduce((sum, r) => sum + (r.repairTimeMinutes || 0), 0);
  const formatRepairTime = (minutes: number) => minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;
  const repairTimes = vehicle?.repairTimes || [];
  // A saved vehicle can be completed in place: the VIN read fills only the
  // details already marked "Not recorded" and saves them onto the record.
  async function suggestVehicleDetails() {
    if (!vehicle) return;
    setVinBusy(true); setVinError(""); setVinNote("");
    try {
      const result = await api<VinLookupResult>("vin-lookup", { vin: vehicle.vin });
      const next = {
        make: vehicle.make || "", model: vehicle.model || "", year: vehicle.year || "",
        engine: vehicle.engine || "", engineModel: vehicle.engineModel || "",
      };
      const filled: string[] = [];
      for (const field of ["make", "model", "year", "engine", "engineModel"] as const) {
        const text = result.fields[field];
        if (!text || next[field].trim()) continue;
        next[field] = text;
        filled.push(vinLabels[field]);
      }
      const caveats = result.warnings.length ? ` ${result.warnings.join(" ")}` : "";
      if (!filled.length) {
        setVinNote(`Nothing this VIN could confirm was missing, so the record was left unchanged.${caveats}`);
        return;
      }
      await api("records", {
        action: "save", entity: "vehicle", id: vehicle.id, kind: "vehicle", vehicleId: "",
        ...next, engineNumber: vehicle.engineNumber || "", registration: vehicle.registration || "",
        licenceNumber: vehicle.licenceNumber || "", colour: vehicle.colour || "", expiry: vehicle.expiry || "",
        vin: vehicle.vin, customer: vehicle.customer || "", specifications: vehicle.specifications || "",
      });
      await refresh();
      setVinNote(`Filled ${filled.join(", ")} from the VIN and saved them. Check them against the vehicle.${caveats}`);
      toast.success(`Added ${filled.join(", ")} from the VIN`);
    } catch (error) { setVinError((error as Error).message); }
    finally { setVinBusy(false); }
  }
  async function refreshRepairTimes() {
    if (!vehicle) return;
    setRefreshing(true);
    try { await api("repair-times", { action: "refresh", vehicleId: vehicle.id }); await refresh(); toast.success("Repair times refreshed"); }
    catch (e) { toast.error((e as Error).message); }
    finally { setRefreshing(false); }
  }
  function startTorques() {
    if (!vehicle) return;
    setTorqueError("");
    setTorqueDraft((vehicle.torqueSpecs || []).map(spec => ({ fastener: spec.fastener, stage: spec.stage, value: String(spec.value), unit: spec.unit })));
  }
  function addTorqueRow() {
    setTorqueDraft(rows => rows ? [...rows, { fastener: "", stage: "", value: "", unit: "Nm" }] : rows);
  }
  function changeTorqueRow(index: number, patch: Partial<TorqueDraftRow>) {
    setTorqueDraft(rows => rows ? rows.map((row, at) => at === index ? { ...row, ...patch } : row) : rows);
  }
  function removeTorqueRow(index: number) {
    setTorqueDraft(rows => rows ? rows.filter((_, at) => at !== index) : rows);
  }
  async function saveTorques() {
    if (!vehicle || !torqueDraft) return;
    // A row that was added and left blank is simply dropped.
    const rows = torqueDraft.filter(row => row.fastener.trim() || row.value.trim());
    if (rows.some(row => !row.fastener.trim() || !Number.isFinite(Number(row.value.replace(",", "."))) || Number(row.value.replace(",", ".")) <= 0)) {
      setTorqueError("Each torque row needs a fastener and a value greater than zero.");
      return;
    }
    setTorqueBusy(true); setTorqueError("");
    try {
      await api("torques", {
        vehicleId: vehicle.id,
        specs: rows.map(row => ({ fastener: row.fastener.trim(), stage: row.stage.trim(), value: Number(row.value.replace(",", ".")), unit: row.unit })),
      });
      await refresh();
      setTorqueDraft(null);
      toast.success("Tightening torques saved");
    } catch (e) { setTorqueError((e as Error).message); }
    finally { setTorqueBusy(false); }
  }
  // The job sheet is a separate overlay on <body>, so Radix would read every
  // click in it as "outside" and close this dialog — taking the sheet with it.
  const sheetShowing = () => Boolean(document.querySelector(".print-overlay"));
  return <><Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent onInteractOutside={event => { if (sheetShowing()) event.preventDefault(); }} onEscapeKeyDown={event => { if (sheetShowing()) event.preventDefault(); }} className="max-h-[90vh] max-w-3xl overflow-y-auto rounded-2xl border-border bg-white p-6 sm:rounded-2xl sm:p-8"><DialogHeader><div className="mb-3 flex items-center gap-2"><Badge variant="secondary" className="rounded-md bg-primary/10 px-2.5 py-1 text-primary">{record ? { procedure: "Service procedure", note: "Repair note", service: "Service history", part: "Part" }[record.kind] : "Vehicle record"}</Badge>{record?.category && <Badge variant="outline" className="rounded-md border-border py-1">{record.category}</Badge>}</div><DialogTitle className="pr-5 font-heading text-2xl font-bold">{title}</DialogTitle><DialogDescription className="pt-2">Added by {item.createdBy} · Updated {prettyDate(item.updatedAt)}</DialogDescription></DialogHeader>
    {record ? <>{vehicle && <button onClick={() => view({ entity: "vehicle", id: vehicle.id })} className="flex items-center gap-2 rounded-xl border border-border bg-background p-4 text-left text-sm font-semibold text-primary"><CarFront size={18} />{vehicle.make} {vehicle.model} {vehicle.year}{vehicle.registration && <span className="ml-auto font-mono text-xs">{vehicle.registration}</span>}</button>}{record.kind === "service" && <div className="flex flex-wrap gap-5 text-xs text-muted-foreground"><span>Service date: <strong className="text-foreground">{record.date ? prettyDate(record.date) : "Not recorded"}</strong></span><span>Odometer: <strong className="text-foreground">{record.mileage || "Not recorded"}</strong></span><span className="flex items-center gap-1.5"><Clock size={13} />Repair time: <strong className="text-foreground">{record.repairTimeMinutes ? formatRepairTime(record.repairTimeMinutes) : "Not recorded"}</strong></span></div>}{record.kind === "part" && <div className="space-y-3 rounded-xl border border-border bg-background/60 p-4"><div className="grid gap-4 text-xs sm:grid-cols-3"><div><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Part number</p><p className="mt-1 break-all font-mono text-sm font-semibold">{record.partNumber || "Not recorded"}</p></div><div><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Part make</p><p className="mt-1 text-sm font-medium">{record.partMake || "Not recorded"}</p></div><div><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Supplier</p><p className="mt-1 text-sm font-medium">{partSupplier?.name || "Not chosen"}</p></div></div><div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3">{[...(partSupplier ? [partSupplier] : []), ...data.suppliers.filter(supplier => supplier.id !== partSupplier?.id)].map(supplier => <a key={supplier.id} href={supplierSearchUrl(supplier, [record.partNumber, record.partMake, record.title, vehicle ? vehicleQuery(vehicle) : ""].filter(Boolean).join(" "))} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/5"><Search size={12} />{supplier.name}</a>)}{vehicle?.vin && <a href={webSearchUrl(`${record.partNumber || record.title} ${vehicle.vin}`)} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1.5 text-[11px] font-semibold text-primary">By VIN</a>}{data.suppliers.length === 0 && <span className="text-[11px] text-muted-foreground">Add a supplier in Settings &amp; members to search its site from here.</span>}</div></div>}{record.content && <div className="whitespace-pre-wrap break-words rounded-xl border border-border bg-background/60 p-5 text-sm leading-7">{record.content}</div>}</> : <><dl className="grid grid-cols-2 gap-x-5 gap-y-5 rounded-xl bg-background p-5">{([["Year", vehicle.year], ["Engine / variant", vehicle.engine], ["Engine model", vehicle.engineModel], ["Engine number", vehicle.engineNumber], ["Registration", vehicle.registration], ["Licence number", vehicle.licenceNumber], ["Colour", vehicle.colour], ["Licence expiry", vehicle.expiry], ["VIN", vehicle.vin], ["Customer / owner", vehicle.customer], ["Repair time logged", totalRepairMinutes ? formatRepairTime(totalRepairMinutes) : ""]] as [string, string][]).map(([label, value]) => <div key={label}><dt className="text-[11px] text-muted-foreground">{label}</dt><dd className="mt-1 break-all text-sm font-medium">{value || "Not recorded"}</dd></div>)}</dl>{canEdit && vehicle.vin && <div className="flex flex-wrap items-center gap-3"><Button type="button" variant="outline" size="sm" disabled={vinBusy} onClick={suggestVehicleDetails} className="h-9 rounded-lg px-3 text-xs font-semibold">{vinBusy ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Sparkles size={13} className="mr-1.5" />}{vinBusy ? "Reading VIN…" : "Suggest missing details from VIN"}</Button><span className="text-[10px] text-muted-foreground">Fills only the details marked “Not recorded”.</span></div>}{(vinError || vinNote) && <p role={vinError ? "alert" : undefined} className={vinError ? "text-xs text-destructive" : "text-xs leading-5 text-primary"}>{vinError || vinNote}</p>}<div><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-bold">Repair times <span className="ml-1 text-muted-foreground">({repairTimes.length})</span></h3><div className="flex items-center gap-3">{vehicle.vin && <a href={`https://partsouq.com/en/search/all?q=${encodeURIComponent(vehicle.vin)}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs font-semibold text-primary">Search VIN on Partsouq<ExternalLink size={13} /></a>}{canEdit && <button onClick={() => { setManualEdit(undefined); setManualOpen(true); }} className="flex items-center gap-1 text-xs font-semibold text-primary"><Plus size={13} />Add repair time</button>}{canEdit && <button onClick={() => setGroqTimesOpen(true)} className="flex items-center gap-1 text-xs font-semibold text-primary"><Sparkles size={13} />Search times with Groq</button>}{canEdit && vehicle.vin && <button onClick={() => setGeminiOpen(true)} className="flex items-center gap-1 text-xs font-semibold text-primary"><Sparkles size={13} />Search times with Gemini</button>}{canEdit && vehicle.vin && <button onClick={refreshRepairTimes} disabled={refreshing} className="flex items-center gap-1 text-xs font-semibold text-primary disabled:opacity-60">{refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}Refresh</button>}</div></div>{repairTimes.length ? <RepairTimeList entries={repairTimes} canEdit={canEdit} formatMinutes={formatRepairTime} onEdit={entry => { setManualEdit(entry); setManualOpen(true); }} /> : <p className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">No repair times yet. Add one by hand, import a repair-time file in Settings, or log service entries.</p>}{vehicle.repairTimesUpdatedAt && <p className="mt-2 text-[10px] text-muted-foreground">Updated {prettyDate(vehicle.repairTimesUpdatedAt)}{vehicle.repairTimesSource ? ` · ${vehicle.repairTimesSource}` : ""}</p>}</div>
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-bold">Tightening torques <span className="ml-1 text-muted-foreground">({vehicle.torqueSpecs?.length || 0})</span></h3>{canEdit && !torqueDraft && <div className="flex flex-wrap items-center justify-end gap-3"><button onClick={() => setSearchOpen(true)} className="flex items-center gap-1 text-xs font-semibold text-primary"><Globe size={14} />Search torque specifications online</button><button onClick={startTorques} className="flex items-center gap-1 text-xs font-semibold text-primary"><Wrench size={14} />{vehicle.torqueSpecs?.length ? "Edit torques" : "Add torques"}</button></div>}</div>
      {torqueDraft ? <div className="rounded-xl border border-border p-4">
        <div className="space-y-2">
          {torqueDraft.length === 0 && <p className="text-xs text-muted-foreground">No torque rows yet. Add the first fastener below.</p>}
          {torqueDraft.map((row, index) => <div key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_6rem_6.5rem_2.5rem]">
            <Input aria-label={`Fastener for row ${index + 1}`} value={row.fastener} onChange={event => changeTorqueRow(index, { fastener: event.target.value })} placeholder="e.g. Front lower arm bolt" maxLength={200} className="h-10 rounded-lg border-border bg-white text-xs" />
            <Input aria-label={`Stage for row ${index + 1}`} value={row.stage} onChange={event => changeTorqueRow(index, { stage: event.target.value })} placeholder="Stage" maxLength={40} className="h-10 rounded-lg border-border bg-white text-xs" />
            <Input aria-label={`Torque value for row ${index + 1}`} value={row.value} onChange={event => changeTorqueRow(index, { value: event.target.value })} inputMode="decimal" placeholder="Value" className="h-10 rounded-lg border-border bg-white text-xs" />
            <Select value={row.unit} onValueChange={value => changeTorqueRow(index, { unit: value as TorqueUnit })}>
              <SelectTrigger aria-label={`Unit for row ${index + 1}`} className="h-10 rounded-lg border-border bg-white text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="rounded-xl border-border bg-white shadow-xl">{torqueUnits.map(unit => <SelectItem key={unit} value={unit} className="rounded-md py-2 text-sm">{unit}</SelectItem>)}</SelectContent>
            </Select>
            <Button aria-label={`Remove torque row ${index + 1}`} variant="ghost" size="icon" onClick={() => removeTorqueRow(index)} className="h-10 w-10 rounded-lg text-destructive"><Trash2 size={14} /></Button>
          </div>)}
        </div>
        {torqueError && <p role="alert" className="mt-3 text-xs text-destructive">{torqueError}</p>}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <Button variant="outline" onClick={addTorqueRow} className="h-9 rounded-lg text-xs"><Plus size={14} className="mr-1.5" />Add row</Button>
          <div className="flex gap-2"><Button variant="ghost" disabled={torqueBusy} onClick={() => { setTorqueDraft(null); setTorqueError(""); }} className="h-9 rounded-lg text-xs">Cancel</Button><Button disabled={torqueBusy} onClick={saveTorques} className="h-9 rounded-lg text-xs">{torqueBusy && <Loader2 size={13} className="mr-1.5 animate-spin" />}Save torques</Button></div>
        </div>
      </div> : vehicle.torqueSpecs?.length ? <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-left text-xs">
          <thead className="bg-background/70 text-[10px] uppercase tracking-wide text-muted-foreground"><tr><th className="px-4 py-2 font-semibold">Fastener</th><th className="w-24 px-3 py-2 font-semibold">Stage</th><th className="w-28 px-4 py-2 text-right font-semibold">Torque</th></tr></thead>
          <tbody className="divide-y divide-border">{vehicle.torqueSpecs.map((spec, index) => <tr key={`${spec.fastener}-${spec.stage}-${index}`}><td className="break-words px-4 py-2.5 align-top">{spec.fastener}</td><td className="px-3 py-2.5 align-top text-muted-foreground">{spec.stage ? `Stage ${spec.stage}` : "—"}</td><td className="whitespace-nowrap px-4 py-2.5 text-right align-top font-semibold text-primary">{spec.value} {spec.unit}</td></tr>)}</tbody>
        </table>
      </div> : <p className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">No tightening torques recorded yet. Paste a torque table from the program or add rows here.</p>}
      {vehicle.torqueSpecsUpdatedAt && !torqueDraft && <p className="mt-2 text-[10px] text-muted-foreground">Updated {prettyDate(vehicle.torqueSpecsUpdatedAt)}</p>}
    </div>
    <div><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-bold">Specifications &amp; notes</h3>{canEdit && <button onClick={() => setGroqSpecsOpen(true)} className="flex items-center gap-1 text-xs font-semibold text-primary"><Sparkles size={14} />Pull specifications with Groq</button>}</div>{vehicle.specifications ? <div className="whitespace-pre-wrap break-words rounded-xl border border-border p-5 text-sm leading-7">{vehicle.specifications}</div> : <p className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">No specifications recorded yet. Pull the manufacturer sheet from the web with Groq, paste one from your program, or edit the vehicle.</p>}</div><div><div className="mb-3 flex items-center justify-between"><h3 className="flex items-center text-sm font-bold">Linked workshop records <span className="ml-1 text-muted-foreground">({linkedRecords.length})</span>{totalRepairMinutes > 0 && <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">⏱ {formatRepairTime(totalRepairMinutes)} logged</span>}</h3>{canEdit && <button onClick={() => edit({ entity: "record", kind: "service", vehicleId: vehicle.id })} className="flex items-center gap-1 text-xs font-semibold text-primary"><Plus size={14} />Log service</button>}</div>{linkedRecords.length ? <div className="space-y-2">{linkedRecords.map(r => <button key={r.id} onClick={() => view({ entity: "record", id: r.id })} className="flex w-full items-center gap-3 rounded-xl border border-border p-3 text-left hover:bg-background"><BookOpen size={17} className="shrink-0 text-primary" /><div className="min-w-0"><p className="truncate text-sm font-medium">{r.title}</p><p className="mt-1 text-[11px] text-muted-foreground">{r.date ? prettyDate(r.date) : prettyDate(r.updatedAt)} · {r.createdBy}{r.kind === "service" && r.repairTimeMinutes ? ` · ⏱ ${formatRepairTime(r.repairTimeMinutes)}` : ""}</p></div></button>)}</div> : <p className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">No service entries, procedures or notes linked yet.</p>}</div></>}
    <div><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-bold">Parts <span className="ml-1 text-muted-foreground">({vehicleParts.length})</span></h3>{canEdit && <button onClick={() => edit({ entity: "record", kind: "part", vehicleId: vehicle.id })} className="flex items-center gap-1 text-xs font-semibold text-primary"><Plus size={14} />Add part</button>}</div>{vehicleParts.length > 0 && <div className="mb-3 space-y-2">{vehicleParts.map(part => <div key={part.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-3"><button onClick={() => view({ entity: "record", id: part.id })} className="flex min-w-0 flex-1 items-center gap-2 text-left"><Package size={15} className="shrink-0 text-primary" /><p className="truncate text-sm font-medium">{part.title}</p><p className="mt-1 font-mono text-[11px] text-muted-foreground">{part.partNumber || "No part number"}{part.partMake ? ` · ${part.partMake}` : ""}{data.suppliers.find(supplier => supplier.id === part.supplierId)?.name ? ` · ${data.suppliers.find(supplier => supplier.id === part.supplierId)?.name}` : ""}</p></button>{data.suppliers.slice(0, 2).map(supplier => <a key={supplier.id} href={supplierSearchUrl(supplier, [part.partNumber, part.partMake, part.title, vehicleQuery(vehicle)].filter(Boolean).join(" "))} target="_blank" rel="noreferrer noopener" title={`Search ${supplier.name}`} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[10px] font-semibold text-primary"><Search size={11} />{supplier.name}</a>)}</div>)}</div>}<div className="rounded-xl border border-dashed border-border p-4"><p className="flex items-center gap-1.5 text-xs font-semibold"><Search size={13} className="text-primary" />Search your suppliers for this vehicle</p><p className="mt-1 text-[11px] leading-5 text-muted-foreground">Opens the supplier's own search with this vehicle already described, by VIN or by make, model and year.</p>{data.suppliers.length === 0 ? <p className="mt-2 text-[11px] text-muted-foreground">No suppliers listed yet. Add them in Settings &amp; members.</p> : <div className="mt-3 space-y-2">{data.suppliers.map(supplier => <div key={supplier.id} className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs font-medium">{supplier.name}</span>{vehicle.vin && <a href={supplierSearchUrl(supplier, vehicleQuery(vehicle, "vin"))} target="_blank" rel="noreferrer noopener" className="rounded-lg bg-primary/10 px-2.5 py-1 text-[10px] font-semibold text-primary">By VIN</a>}<a href={supplierSearchUrl(supplier, vehicleQuery(vehicle))} target="_blank" rel="noreferrer noopener" className="rounded-lg border border-border px-2.5 py-1 text-[10px] font-semibold text-primary">By make &amp; model</a></div>)}</div>}</div></div>
    <div><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-bold">Attachments <span className="text-muted-foreground">({files.length})</span></h3>{canEdit && <button onClick={() => upload(item.id)} className="flex items-center gap-1 text-xs font-semibold text-primary"><Plus size={14} />Attach file</button>}</div>{files.length ? <div className="space-y-2">{files.map(file => <div key={file.id} className="flex items-center gap-3 rounded-xl border border-border p-3"><FileText size={19} className="shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{file.name}</p><p className="mt-1 text-[11px] text-muted-foreground">{fileSize(file.size)}</p></div><Button aria-label={`Download ${file.name}`} variant="ghost" size="icon" className="h-8 w-8 rounded-lg text-primary" onClick={() => download(`attachments/${file.id}`, file.name).catch(e => toast.error(e.message))}><Download size={16} /></Button></div>)}</div> : <p className="text-xs text-muted-foreground">No files attached.</p>}</div>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-5">
      {record ? record.kind === "service" ? <Button variant="outline" disabled={!vehicle} onClick={() => setSheetOpen(true)} className="h-10 rounded-lg text-xs"><Printer size={15} className="mr-2" />Print job sheet</Button> : null : serviceRecords.length ? <Button variant="outline" disabled={!vehicle} onClick={() => setSheetOpen(true)} className="h-10 rounded-lg text-xs"><Printer size={15} className="mr-2" />Print service history</Button> : <span className="text-xs text-muted-foreground">No service entries to print yet</span>}
      {canEdit ? <div className="flex gap-2"><Button variant="ghost" className="rounded-lg text-destructive hover:bg-destructive/5 hover:text-destructive" onClick={() => remove(target.entity, item.id, title)}><Trash2 size={15} className="mr-2" />Delete</Button><Button className="rounded-lg px-5" onClick={() => edit(record ? { entity: "record", kind: record.kind, value: record } : { entity: "vehicle", value: vehicle })}><Pencil size={15} className="mr-2" />Edit record</Button></div> : <span />}
    </div>
  </DialogContent></Dialog>{searchOpen && vehicle && <TorqueSearch vehicle={vehicle} close={() => setSearchOpen(false)} onPaste={() => { setSearchOpen(false); setPasteTorqueOpen(true); }} refresh={refresh} />}{pasteTorqueOpen && vehicle && <PasteTimes data={data} defaultVehicleId={vehicle.id} close={() => setPasteTorqueOpen(false)} refresh={refresh} />}{geminiOpen && vehicle && <GeminiSearch vehicle={vehicle} close={() => setGeminiOpen(false)} refresh={refresh} />}{groqSpecsOpen && vehicle && <GroqSpecs vehicle={vehicle} close={() => setGroqSpecsOpen(false)} refresh={refresh} />}{groqTimesOpen && vehicle && <GroqRepairTimes vehicle={vehicle} close={() => setGroqTimesOpen(false)} refresh={refresh} />}{manualOpen && vehicle && <ManualRepairTimes vehicle={vehicle} entry={manualEdit} close={() => setManualOpen(false)} refresh={refresh} />}{sheetOpen && vehicle && <JobSheet workshop={data.name} user={data.user} vehicle={vehicle} entry={record} history={serviceRecords} close={() => setSheetOpen(false)} />}</>;
}
