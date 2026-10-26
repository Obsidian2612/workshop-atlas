import { useState } from "react";
import { ClipboardPaste, ExternalLink, Loader2, Wrench } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/workshop-api";
import type { RepairSheetOperation, TorqueSpec, VehicleIdentification, Workspace } from "@/lib/workshop-types";
import { Pick } from "./primitives";
import { toast } from "sonner";

/*
 * Manual capture, not scraping: the user copies rows or a vehicle
 * identification screen from the licensed program they are already looking at
 * and pastes them here. The server parses the text and shows every value before
 * anything is written, and detected vehicle fields stay editable.
 */

type PasteResult = { operations: RepairSheetOperation[]; skipped: number; torques: TorqueSpec[]; vehicle: VehicleIdentification | null };

const same = (left: string, right: string) => !left.trim() || left.trim().toLowerCase() === right.trim().toLowerCase();

export default function PasteTimes({ data, defaultVehicleId, close, refresh }: { data: Workspace; defaultVehicleId?: string; close: () => void; refresh: () => Promise<void> }) {
  const [vehicleId, setVehicleId] = useState(defaultVehicleId || data.vehicles[0]?.id || "none");
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<PasteResult | null>(null);
  const [details, setDetails] = useState<VehicleIdentification | null>(null);
  const [createNew, setCreateNew] = useState(false);
  const [busy, setBusy] = useState<"read" | "apply" | "">("");
  const [error, setError] = useState("");
  const vehicle = data.vehicles.find(item => item.id === vehicleId);
  const operations = parsed?.operations ?? [];
  const torques = parsed?.torques ?? [];
  const total = operations.reduce((sum, operation) => sum + operation.minutes, 0);
  const hours = (minutes: number) => `${(minutes / 60).toFixed(2)} h`;
  const hasDetails = Boolean(details && Object.values(details).some(value => value.trim()));
  const newVehicleReady = Boolean(details?.make.trim() && details?.model.trim());
  const creating = hasDetails && createNew;
  const hasPaste = operations.length > 0 || torques.length > 0;
  const canApply = Boolean(parsed) && (hasPaste || hasDetails) && (creating ? newVehicleReady : vehicleId !== "none");
  const targetName = creating ? `${details?.make ?? ""} ${details?.model ?? ""}`.trim() : vehicle ? `${vehicle.make} ${vehicle.model}`.trim() : "";
  const applyLabel = creating ? "Create vehicle & save" : "Apply paste";

  function changeText(value: string) {
    setText(value);
    setParsed(null);
    setDetails(null);
    setCreateNew(false);
    setError("");
  }

  function changeDetail(field: keyof VehicleIdentification, value: string) {
    setDetails(current => current ? { ...current, [field]: value } : current);
    if (field !== "make" && field !== "model") setCreateNew(false);
    setError("");
  }

  async function readPaste() {
    setBusy("read"); setError(""); setParsed(null);
    try {
      const result = await api<PasteResult>("repair-times", { action: "paste", text });
      setParsed(result);
      setDetails(result.vehicle);
      if (result.vehicle) {
        // Default to updating the selected vehicle only when the pasted details
        // already name it; otherwise a new vehicle is the safe target.
        const selected = data.vehicles.find(item => item.id === vehicleId);
        setCreateNew(!selected || !same(result.vehicle.make, selected.make) || !same(result.vehicle.model, selected.model));
      } else {
        setCreateNew(false);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  }

  async function applyPaste() {
    if (!parsed) return;
    const values = details ? { make: details.make.trim(), model: details.model.trim(), year: details.year.trim(), engine: details.engine.trim() } : null;
    if (creating && (!values?.make || !values?.model)) { setError("A make and model are needed to create a vehicle."); return; }
    if (!creating && vehicleId === "none") { setError("Choose the vehicle to save this to."); return; }
    setBusy("apply"); setError("");
    try {
      let targetId = creating ? "" : vehicleId;
      let createdName = "";
      if (details && hasDetails) {
        if (creating) {
          const created = await api<{ id: string }>("records", {
            action: "save", entity: "vehicle", make: values.make, model: values.model,
            year: values.year, engine: values.engine, registration: "", vin: "", customer: "", specifications: "",
          });
          targetId = created.id;
          createdName = `${values.make} ${values.model}`.trim();
        } else if (targetId !== "none") {
          const current = data.vehicles.find(item => item.id === targetId);
          await api("records", {
            action: "save", entity: "vehicle", id: targetId,
            make: values.make || current?.make || "", model: values.model || current?.model || "",
            year: values.year || current?.year || "", engine: values.engine || current?.engine || "",
            registration: current?.registration || "", vin: current?.vin || "",
            customer: current?.customer || "", specifications: current?.specifications || "",
          });
        }
      }
      let applied = 0;
      let appliedTorques = 0;
      if (hasPaste) {
        const result = await api<{ applied: number; torques?: number }>("repair-times", { action: "paste", text, vehicleId: targetId, apply: true });
        applied = result.applied;
        appliedTorques = result.torques ?? 0;
      }
      await refresh();
      const name = createdName || (vehicle ? `${vehicle.make} ${vehicle.model}`.trim() : "the vehicle");
      const parts: string[] = [];
      if (details && hasDetails) parts.push(`${creating ? "Added" : "Updated"} ${name}`);
      if (applied) parts.push(`applied ${applied} operation${applied === 1 ? "" : "s"}`);
      if (appliedTorques) parts.push(`saved ${appliedTorques} torque row${appliedTorques === 1 ? "" : "s"}`);
      toast.success(parts.join(" and ") || "Saved");
      close();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
    <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto rounded-2xl border-border bg-white p-6 sm:rounded-2xl sm:p-8">
      <DialogHeader>
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><ClipboardPaste size={22} /></span>
        <DialogTitle className="font-heading text-2xl font-bold">Paste from the program</DialogTitle>
        <DialogDescription className="pt-1 leading-6">Copy operation rows, a tightening-torque table or a vehicle identification screen from the program you are already using and paste them below. This app only reads what you paste; it never connects to the VM by itself.</DialogDescription>
      </DialogHeader>
      <div className="mt-3 space-y-5">
        {data.vmUrl && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background/70 px-4 py-3"><p className="text-[11px] text-muted-foreground">Select the text in the program, copy it, then paste here.</p><Button asChild variant="outline" className="h-9 rounded-lg px-3 text-xs"><a href={data.vmUrl} target="_blank" rel="noopener noreferrer">Open the VM<ExternalLink size={14} className="ml-2" /></a></Button></div>}

        {hasDetails && details && <div className="rounded-xl border border-primary/20">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-primary/5 px-4 py-3"><p className="text-xs font-semibold">Vehicle details found</p><p className="text-[11px] text-muted-foreground">Check and edit before saving</p></div>
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {([["make", "Make"], ["model", "Model"], ["year", "Year"], ["engine", "Engine / variant"], ["capacity", "Engine capacity"], ["torque", "Engine torque"]] as const).map(([field, label]) => <label key={field} className="text-xs font-semibold">{label}<Input value={details[field]} onChange={event => changeDetail(field, event.target.value)} maxLength={field === "year" ? 4 : field === "make" ? 80 : field === "capacity" ? 40 : field === "torque" ? 60 : 100} className="mt-2 h-10 rounded-lg" /></label>)}
          </div>
          <label className="flex items-start gap-2 border-t border-border px-4 py-3 text-xs">
            <Checkbox checked={createNew} onCheckedChange={value => { setCreateNew(value === true); setError(""); }} className="mt-0.5" />
            <span><span className="font-semibold">Create a new vehicle</span><span className="mt-1 block text-[11px] leading-5 text-muted-foreground">{createNew && !newVehicleReady ? "Add a make and model above to create the vehicle." : "Leave unticked to fill these fields on the vehicle selected below."}</span></span>
          </label>
        </div>}

        {data.vehicles.length ? (creating
          ? <p className="rounded-lg bg-background px-4 py-3 text-[11px] text-muted-foreground">The new vehicle will be created from the details above; pasted times and torques are added to it.</p>
          : <div><Label className="mb-2 block text-xs font-semibold">Save the pasted rows to</Label><Pick label="Vehicle" value={vehicleId} onChange={value => { setVehicleId(value); setError(""); }} options={data.vehicles.map(item => ({ value: item.id, label: `${item.make} ${item.model}${item.registration ? ` · ${item.registration}` : item.year ? ` · ${item.year}` : ""}` }))} /><p className="mt-2 text-[11px] leading-5 text-muted-foreground">Operations already on this vehicle with the same description are replaced. Torque rows replace rows with the same fastener and stage.</p></div>)
          : <p className={`rounded-lg p-3 text-sm ${creating ? "bg-background text-muted-foreground" : "bg-destructive/5 text-destructive"}`}>{creating ? "The new vehicle will be created from the details above." : "Add a vehicle first, or paste a vehicle identification screen and create one from it."}</p>}

        <div>
          <Label htmlFor="paste-times" className="text-xs font-semibold">Copied text</Label>
          <Textarea id="paste-times" value={text} onChange={event => changeText(event.target.value)} autoFocus maxLength={200000} placeholder={"A1.0100  Engine & transmission complete  R & I  5.70\nFront lower arm bolt | Stage 1 | 90 | Nm\nRear caliper carrier | Stage 2 | 66 | lbf·ft\n\nYear  1990\nManufacturer  Alfa Romeo\nModel range  75\nEngine  307.50"} className="mt-2 min-h-36 rounded-xl border-border bg-white font-mono text-xs leading-6" />
          <p className="mt-2 text-[11px] leading-5 text-muted-foreground">Operation rows: one per line, tab-separated columns or plain lines ending in hours (5.70 or 5,70). Torque rows need a recognised unit (Nm, lbf·ft, lbf·in, kgf·m). Identification screens can be labelled lines or the copied table.</p>
        </div>
        {error && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
        {parsed && (operations.length > 0 || torques.length > 0) && <>
          {operations.length > 0 && <div className="rounded-xl border border-border">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background/70 px-4 py-3"><p className="text-xs font-semibold">{operations.length} operation{operations.length === 1 ? "" : "s"} · {hours(total)}</p>{parsed.skipped > 0 && <p className="text-[11px] text-muted-foreground">{parsed.skipped} line{parsed.skipped === 1 ? "" : "s"} skipped</p>}</div>
            <div className="max-h-56 divide-y divide-border overflow-y-auto">{operations.map((operation, index) => <div key={`${operation.operation}-${index}`} className="flex items-start justify-between gap-4 px-4 py-2.5 text-xs"><span className="min-w-0"><span className="block break-words">{operation.operation}</span>{operation.code && <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{operation.code}</span>}</span><span className="shrink-0 font-semibold text-primary">{hours(operation.minutes)}</span></div>)}</div>
          </div>}
          {torques.length > 0 && <div className="rounded-xl border border-border">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background/70 px-4 py-3"><p className="flex items-center gap-1.5 text-xs font-semibold"><Wrench size={13} />{torques.length} tightening torque{torques.length === 1 ? "" : "s"}</p><p className="text-[11px] text-muted-foreground">Only rows with a recognised unit</p></div>
            <div className="max-h-52 divide-y divide-border overflow-y-auto">{torques.map((spec, index) => <div key={`${spec.fastener}-${spec.stage}-${index}`} className="flex items-start justify-between gap-4 px-4 py-2.5 text-xs"><span className="min-w-0"><span className="block break-words">{spec.fastener}</span>{spec.stage && <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-muted-foreground">Stage {spec.stage}</span>}</span><span className="shrink-0 font-semibold text-primary">{spec.value} {spec.unit}</span></div>)}</div>
          </div>}
        </>}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-5">
          <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={close} className="h-11 rounded-lg px-5">Cancel</Button>
          <Button type="button" variant="outline" disabled={Boolean(busy) || !text.trim()} onClick={readPaste} className="h-11 rounded-lg px-5">{busy === "read" && <Loader2 size={15} className="mr-2 animate-spin" />}Read paste</Button>
          <Button type="button" disabled={Boolean(busy) || !canApply} onClick={applyPaste} className="h-11 rounded-lg px-6">{busy === "apply" && <Loader2 size={15} className="mr-2 animate-spin" />}{applyLabel}</Button>
        </div>
        {parsed && canApply && <p className="text-right text-[11px] text-muted-foreground">Writes to <span className="font-semibold text-foreground">{targetName || "the vehicle"}</span>.</p>}
      </div>
    </DialogContent>
  </Dialog>;
}
