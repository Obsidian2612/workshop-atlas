import { useState } from "react";
import { Loader2, CarFront, BookOpen, StickyNote, History } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/workshop-api";
import type { RecordKind, Vehicle, WorkshopRecord, Workspace } from "@/lib/workshop-types";
import { Pick } from "./primitives";
import { toast } from "sonner";export type EditorTarget = { entity: "vehicle"; value?: Vehicle } | { entity: "record"; kind: RecordKind; value?: WorkshopRecord; vehicleId?: string };
export default function RecordEditor({ target, close, data, refresh }: { target: EditorTarget; close: () => void; data: Workspace; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [vehicleId, setVehicleId] = useState(target.entity === "record" ? target.value?.vehicleId || target.vehicleId || "none" : "none");
  const value = target.value;
  const isVehicle = target.entity === "vehicle";
  const kind = target.entity === "record" ? target.kind : "vehicle";
  const label = { vehicle: "vehicle", procedure: "service procedure", note: "repair note", service: "service entry" }[kind];
  const Icon = { vehicle: CarFront, procedure: BookOpen, note: StickyNote, service: History }[kind];
  const repairTimeLabel = kind === "service" ? "Repair time (minutes)" : "";
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api("records", { ...fields, action: "save", entity: target.entity, id: value?.id || "", kind, vehicleId: vehicleId === "none" ? "" : vehicleId });
      await refresh(); close(); toast.success(`${value ? "Updated" : "Added"} ${label}`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto rounded-2xl border-border bg-white p-6 sm:rounded-2xl sm:p-8"><DialogHeader><span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon size={22} /></span><DialogTitle className="font-heading text-2xl font-bold">{value ? "Edit" : "Add"} {label}</DialogTitle><DialogDescription className="pt-1">Your team's own information, saved to your workshop server.</DialogDescription></DialogHeader>
    <form onSubmit={save} className="mt-3 space-y-5">{isVehicle ? <VehicleFields value={value as Vehicle | undefined} /> : <>
      <Field label="Title" name="title" defaultValue={(value as WorkshopRecord)?.title} placeholder={kind === "procedure" ? "e.g. Annual inspection checklist" : kind === "service" ? "e.g. Oil and filter service" : "e.g. Intermittent starting issue"} required maxLength={200} />
      <div className="grid gap-4 sm:grid-cols-2"><div><Label className="mb-2 block text-xs font-semibold">Vehicle {kind !== "service" && <span className="font-normal text-muted-foreground">(optional)</span>}</Label><Pick label="Linked vehicle" value={vehicleId} onChange={setVehicleId} options={[{ value: "none", label: "General workshop reference" }, ...data.vehicles.map(v => ({ value: v.id, label: `${v.make} ${v.model} ${v.registration ? `· ${v.registration}` : v.year}` }))]} />{kind === "service" && data.vehicles.length === 0 && <p className="mt-2 text-xs text-destructive">Add a vehicle before recording its service history.</p>}</div><Field label="Category" name="category" defaultValue={(value as WorkshopRecord)?.category} placeholder="e.g. Maintenance, diagnostics" maxLength={100} /></div>
      {kind === "service" && <div className="grid gap-4 sm:grid-cols-2"><Field label="Service date" type="date" name="date" required defaultValue={(value as WorkshopRecord)?.date || new Date().toISOString().slice(0, 10)} /><Field label="Odometer reading" name="mileage" defaultValue={(value as WorkshopRecord)?.mileage} placeholder="e.g. 85,420 km" maxLength={40} /></div>}
      {kind === "service" && repairTimeLabel !== "" && <div className="grid gap-4 sm:grid-cols-2"><Label htmlFor="repairTimeMinutes" className="text-xs font-semibold">Repair time (minutes)</Label><Input type="number" id="repairTimeMinutes" name="repairTimeMinutes" min="0" max="1440" defaultValue={(value as WorkshopRecord)?.repairTimeMinutes || ""} placeholder="e.g. 45" className="mt-2 h-11 rounded-lg border-border bg-white text-sm" />{kind === "service" && data.vehicles.length === 0 && <p className="mt-2 text-xs text-destructive">Add a vehicle before recording its service history.</p>}</div>}
      <div><Label htmlFor="content" className="text-xs font-semibold">{kind === "procedure" ? "Procedure and specifications" : kind === "service" ? "Work performed" : "Symptoms, findings and repair notes"}</Label><Textarea id="content" name="content" required defaultValue={(value as WorkshopRecord)?.content} maxLength={30000} placeholder={kind === "procedure" ? "Write the steps, required tools and verified specifications…" : "Record what you found and what you did…"} className="mt-2 min-h-44 rounded-xl border-border bg-white text-sm leading-6" /><p className="mt-2 text-[11px] text-muted-foreground">Verify safety-critical values against an authorised source. Attach photos after saving.</p></div>
    </>}{error && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}<div className="flex justify-end gap-2 border-t border-border pt-5"><Button type="button" variant="outline" disabled={busy} onClick={close} className="h-11 rounded-lg px-5">Cancel</Button><Button disabled={busy || (kind === "service" && vehicleId === "none")} className="h-11 rounded-lg px-6">{busy && <Loader2 size={16} className="mr-2 animate-spin" />}Save {label}</Button></div></form>
  </DialogContent></Dialog>;
}
function VehicleFields({ value }: { value?: Vehicle }) {
  return <><div className="grid gap-4 sm:grid-cols-2"><Field label="Make" name="make" required defaultValue={value?.make} placeholder="e.g. Volkswagen" maxLength={80} /><Field label="Model" name="model" required defaultValue={value?.model} placeholder="e.g. Golf" maxLength={100} /><Field label="Year" name="year" inputMode="numeric" pattern="[0-9]{4}" defaultValue={value?.year} placeholder="e.g. 2018" maxLength={4} /><Field label="Engine / variant" name="engine" defaultValue={value?.engine} placeholder="e.g. 1.6 TDI" maxLength={100} /><Field label="Engine model" name="engineModel" defaultValue={value?.engineModel} placeholder="e.g. CWVA, K20C" maxLength={100} /><Field label="Engine number" name="engineNumber" defaultValue={value?.engineNumber} placeholder="Stamped engine number" maxLength={60} /><Field label="Registration" name="registration" defaultValue={value?.registration} placeholder="Registration number" maxLength={30} /><Field label="VIN" name="vin" defaultValue={value?.vin} placeholder="Vehicle identification number" maxLength={30} /></div><Field label="Customer / owner" name="customer" defaultValue={value?.customer} placeholder="Customer or fleet name (optional)" maxLength={200} /><div><Label htmlFor="specifications" className="text-xs font-semibold">Specifications and vehicle notes</Label><Textarea id="specifications" name="specifications" defaultValue={value?.specifications} maxLength={20000} placeholder="Add your verified specifications, fluid information or vehicle notes…" className="mt-2 min-h-32 rounded-xl border-border bg-white text-sm leading-6" /></div></>;
}
function Field({ label, ...props }: React.ComponentProps<typeof Input> & { label: string }) {
  return <div><Label htmlFor={props.name} className="text-xs font-semibold">{label}</Label><Input {...props} id={props.name} className="mt-2 h-11 rounded-lg border-border bg-white text-sm" /></div>;
}

