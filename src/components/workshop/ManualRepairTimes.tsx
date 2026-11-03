import { useState } from "react";
import { Clock, Loader2, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/workshop-api";
import { repairScopeCodes, type RepairTimeEntry, type Vehicle } from "@/lib/workshop-types";
import { Pick } from "./primitives";
import { toast } from "sonner";

type StepDraft = { label: string; scope: string; minutes: string };

const scopeOptions = [
  { value: "none", label: "No code" },
  ...repairScopeCodes.map(code => ({ value: code, label: code })),
];

const today = () => new Date().toISOString().slice(0, 10);

/*
 * A repair time recorded by hand: the operation's own time, the code indicating
 * whether it is a remove-and-install or a service-and-repair, and the individual
 * steps the time includes. Everything here is the reader's own data.
 */
export default function ManualRepairTimes({ vehicle, entry, close, refresh }: {
  vehicle: Vehicle;
  entry?: RepairTimeEntry;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [operation, setOperation] = useState(entry?.operation || "");
  const [scope, setScope] = useState(entry?.scope || "none");
  const [minutes, setMinutes] = useState(entry ? String(entry.minutes) : "");
  const [capturedAt, setCapturedAt] = useState(entry?.capturedAt || today());
  const [notes, setNotes] = useState(entry?.notes || "");
  const [steps, setSteps] = useState<StepDraft[]>((entry?.includes || []).map(step => ({ label: step.label, scope: step.scope || "none", minutes: String(step.minutes) })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const code = scope === "none" ? "" : scope;
  const includedMinutes = steps.reduce((sum, step) => sum + (Number(step.minutes) || 0), 0);

  function changeStep(index: number, patch: Partial<StepDraft>) {
    setSteps(current => current.map((step, at) => at === index ? { ...step, ...patch } : step));
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const value = Number(minutes);
    if (!Number.isInteger(value) || value < 0 || value > 1440) {
      setError("Repair time must be a whole number of minutes between 0 and 1440.");
      return;
    }
    if (includedMinutes > 1440) {
      setError("The included steps add up to more than 1440 minutes.");
      return;
    }
    setBusy(true);
    try {
      await api("repair-times", {
        action: "manual",
        vehicleId: vehicle.id,
        originalOperation: entry?.operation || "",
        entry: {
          operation: operation.trim(),
          minutes: value,
          scope: code,
          capturedAt,
          notes: notes.trim(),
          includes: steps
            .filter(step => step.label.trim())
            .map(step => ({ label: step.label.trim(), scope: step.scope === "none" ? "" : step.scope, minutes: Number(step.minutes) || 0 })),
        },
      });
      await refresh();
      toast.success(entry ? "Repair time updated" : "Repair time added");
      close();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!entry) return;
    setBusy(true); setError("");
    try {
      await api("repair-times", { action: "manual", vehicleId: vehicle.id, remove: entry.operation });
      await refresh();
      toast.success("Repair time deleted");
      close();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
    <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto rounded-2xl border-border bg-white p-6 sm:rounded-2xl sm:p-8">
      <DialogHeader>
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Clock size={22} /></span>
        <DialogTitle className="font-heading text-2xl font-bold">{entry ? "Edit repair time" : "Add repair time"}</DialogTitle>
        <DialogDescription className="pt-1 leading-6">
          Saved to <span className="font-semibold text-foreground">{vehicle.make} {vehicle.model}{vehicle.year ? ` ${vehicle.year}` : ""}</span> as your own record. A capture date in the future lists the time as upcoming.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={save} className="mt-3 space-y-5">
        <div>
          <Label htmlFor="operation" className="text-xs font-semibold">Operation</Label>
          <Input id="operation" value={operation} onChange={event => setOperation(event.target.value)} required maxLength={200} placeholder="e.g. Replace camshaft drive belt" className="mt-2 h-11 rounded-lg border-border bg-white text-sm" />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Label className="mb-2 block text-xs font-semibold">Code</Label>
            <Pick label="Operation code" value={scope} onChange={setScope} options={scopeOptions} />
            <p className="mt-2 text-[11px] leading-4 text-muted-foreground">R&amp;I = remove and install, S&amp;R = service and repair.</p>
          </div>
          <div>
            <Label htmlFor="minutes" className="text-xs font-semibold">Repair time (minutes)</Label>
            <Input id="minutes" type="number" min="0" max="1440" step="1" value={minutes} onChange={event => setMinutes(event.target.value)} required placeholder="e.g. 90" className="mt-2 h-11 rounded-lg border-border bg-white text-sm" />
          </div>
          <div>
            <Label htmlFor="capturedAt" className="text-xs font-semibold">Captured for</Label>
            <Input id="capturedAt" type="date" value={capturedAt} onChange={event => setCapturedAt(event.target.value)} className="mt-2 h-11 rounded-lg border-border bg-white text-sm" />
          </div>
        </div>

        <div className="rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold">Steps this time includes</p>
              <p className="mt-1 text-[11px] text-muted-foreground">{steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"} · ${includedMinutes} min total` : "Optional. List the bundled operations and their own codes."}</p>
            </div>
            <Button type="button" variant="outline" onClick={() => setSteps(current => [...current, { label: "", scope: "R&I", minutes: "" }])} className="h-9 rounded-lg text-xs"><Plus size={14} className="mr-1.5" />Add step</Button>
          </div>

          {steps.length > 0 && <div className="mt-3 space-y-2">{steps.map((step, index) => <div key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_5.5rem_2.5rem]">
            <Input aria-label={`Step ${index + 1} description`} value={step.label} onChange={event => changeStep(index, { label: event.target.value })} placeholder="e.g. Camshaft/valve cover & gasket" maxLength={200} className="h-10 rounded-lg border-border bg-white text-xs" />
            <Pick label={`Step ${index + 1} code`} value={step.scope} onChange={value => changeStep(index, { scope: value })} options={scopeOptions} />
            <Input aria-label={`Step ${index + 1} minutes`} type="number" min="0" max="1440" step="1" value={step.minutes} onChange={event => changeStep(index, { minutes: event.target.value })} placeholder="min" className="h-10 rounded-lg border-border bg-white text-xs" />
            <Button type="button" aria-label={`Remove step ${index + 1}`} variant="ghost" size="icon" onClick={() => setSteps(current => current.filter((_, at) => at !== index))} className="h-10 w-10 rounded-lg text-destructive"><Trash2 size={14} /></Button>
          </div>)}</div>}
        </div>

        <div>
          <Label htmlFor="notes" className="text-xs font-semibold">Notes</Label>
          <Textarea id="notes" value={notes} onChange={event => setNotes(event.target.value)} maxLength={500} placeholder="Where the time came from, what it assumes, anything the next reader needs." className="mt-2 min-h-24 rounded-xl border-border bg-white text-sm leading-6" />
        </div>

        {error && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-5">
          {entry && entry.source === "manual" ? <Button type="button" variant="ghost" disabled={busy} onClick={remove} className="h-11 rounded-lg px-4 text-destructive hover:bg-destructive/5 hover:text-destructive"><Trash2 size={15} className="mr-2" />Delete</Button> : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={close} className="h-11 rounded-lg px-5">Cancel</Button>
            <Button disabled={busy} className="h-11 rounded-lg px-6">{busy && <Loader2 size={16} className="mr-2 animate-spin" />}{entry ? "Save repair time" : "Add repair time"}</Button>
          </div>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
