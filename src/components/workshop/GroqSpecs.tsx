import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Clock, ExternalLink, Loader2, Sparkles, Wrench } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/workshop-api";
import type { Vehicle, VehicleSpecSheet } from "@/lib/workshop-types";
import { toast } from "sonner";

/*
 * Two-step online lookup for the whole workshop sheet: identification,
 * emissions, capacities, brake dimensions, tightening torques and repair
 * times. Groq only proposes the rows; the reader picks the sections they trust
 * and nothing is written to the vehicle until they confirm.
 */
const formatMinutes = (minutes: number) => minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;

export default function GroqSpecs({ vehicle, close, refresh }: { vehicle: Vehicle; close: () => void; refresh: () => Promise<void> }) {
  const [sheet, setSheet] = useState<VehicleSpecSheet | null>(null);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [torquesOn, setTorquesOn] = useState(true);
  const [timesOn, setTimesOn] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [cancelled, setCancelled] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const chosen = sheet ? sheet.sections.filter((_, index) => selected[index]) : [];
  const chosenRows = chosen.reduce((sum, section) => sum + section.rows.length, 0);
  const chosenTorques = torquesOn ? sheet?.torques.length || 0 : 0;
  const chosenTimes = timesOn ? sheet?.repairTimes.length || 0 : 0;
  const total = chosenRows + chosenTorques + chosenTimes;
  const unconfigured = /GROQ_API_KEY/.test(error);

  useEffect(() => { void run(); }, [vehicle.id]);
  useEffect(() => () => { controller.current?.abort(); }, []);

  async function run() {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setLoading(true); setError(""); setSaveError(""); setCancelled(false); setSheet(null);
    try {
      const result = await api<{ sheet: VehicleSpecSheet }>("groq-vehicle-spec", { vehicleId: vehicle.id }, active.signal);
      if (active.signal.aborted) return;
      setSheet(result.sheet);
      setSelected(Object.fromEntries(result.sheet.sections.map((_, index) => [index, true])));
      setTorquesOn(result.sheet.torques.length > 0);
      setTimesOn(result.sheet.repairTimes.length > 0);
    } catch (e) {
      if (active.signal.aborted) return;
      setError((e as Error).message);
    } finally {
      if (controller.current === active) { controller.current = null; setLoading(false); }
    }
  }

  function cancel() {
    // While waiting, stop the lookup but keep the dialog open so it can be retried.
    if (loading && controller.current) {
      controller.current?.abort();
      controller.current = null;
      setLoading(false);
      setCancelled(true);
      return;
    }
    close();
  }

  function dismiss() {
    controller.current?.abort();
    controller.current = null;
    close();
  }

  async function save() {
    if (!sheet || !chosen.length) return;
    setSaving(true); setSaveError("");
    try {
      await api("groq-vehicle-spec", {
        vehicleId: vehicle.id,
        apply: true,
        identification: sheet.identification,
        sections: chosen,
        torques: torquesOn ? sheet.torques : [],
        repairTimes: timesOn ? sheet.repairTimes : [],
      });
      await refresh();
      const parts = [
        chosen.length ? `${chosen.length} section${chosen.length === 1 ? "" : "s"}` : "",
        chosenTorques ? `${chosenTorques} torques` : "",
        chosenTimes ? `${chosenTimes} repair time${chosenTimes === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      toast.success(`Saved ${parts.join(" and ")}`);
      close();
    } catch (e) { setSaveError((e as Error).message); }
    finally { setSaving(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !saving) dismiss(); }}>
    <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto rounded-2xl border-border bg-white p-6 sm:rounded-2xl sm:p-8">
      <DialogHeader>
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Sparkles size={22} /></span>
        <DialogTitle className="font-heading text-2xl font-bold">Pull specifications with Groq</DialogTitle>
        <DialogDescription className="pt-1 leading-6">
          Ask Groq to search the web for the full workshop sheet on <span className="font-semibold text-foreground">{vehicle.make} {vehicle.model}{vehicle.year ? ` ${vehicle.year}` : ""}</span> — specifications, tightening torques and repair times
          {vehicle.vin ? <> using VIN <span className="font-mono text-foreground">{vehicle.vin}</span></> : null}
          {vehicle.engineModel || vehicle.engine ? <> · <span className="text-foreground">{vehicle.engineModel || vehicle.engine}</span></> : null}. Nothing is saved until you review the sections and confirm.
        </DialogDescription>
      </DialogHeader>

      <div className="mt-3 space-y-4">
        {loading && <div className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-border bg-background/60 px-4 py-12 text-sm text-muted-foreground"><Loader2 size={19} className="animate-spin text-primary" />Searching specifications with Groq…<Button type="button" variant="outline" onClick={cancel} className="h-8 rounded-lg px-3 text-xs">Cancel</Button></div>}

        {!loading && error && <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">{error}</p>
          {unconfigured && <p className="mt-2 text-[11px] leading-5 text-muted-foreground">An administrator can enable this by setting <code className="rounded bg-white px-1">GROQ_API_KEY</code> in the server environment and restarting the app. The default model is <code className="rounded bg-white px-1">openai/gpt-oss-20b</code>.</p>}
          {!unconfigured && <Button variant="outline" onClick={() => run()} className="mt-3 h-9 rounded-lg text-xs">Try again</Button>}
        </div>}

        {!loading && !error && sheet && <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-background/60 px-4 py-3">
            <div>
              <p className="text-xs font-semibold">{sheet.sections.length} section{sheet.sections.length === 1 ? "" : "s"} · {sheet.sections.reduce((sum, section) => sum + section.rows.length, 0)} values{sheet.repairTimes.length ? ` · ${sheet.repairTimes.length} repair times` : ""}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">{[sheet.identification.year, sheet.identification.engine, sheet.identification.engineModel].filter(Boolean).join(" · ") || "Vehicle identified from the search"}</p>
            </div>
            <Badge variant="secondary" className="rounded-md bg-white px-2 py-1 text-[10px]">Groq · {sheet.sources.length} source{sheet.sources.length === 1 ? "" : "s"}</Badge>
          </div>

          <div className="max-h-[46vh] space-y-3 overflow-y-auto pr-1">
            {sheet.sections.map((section, index) => <div key={`${section.title}-${index}`} className={`rounded-xl border ${selected[index] ? "border-primary/25" : "border-border"} bg-white`}>
              <label className="flex cursor-pointer items-center gap-3 border-b border-border/70 px-4 py-2.5">
                <Checkbox checked={Boolean(selected[index])} onCheckedChange={value => setSelected(current => ({ ...current, [index]: value === true }))} />
                <span className="text-xs font-bold uppercase tracking-wide text-foreground">{section.title}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{section.rows.length} value{section.rows.length === 1 ? "" : "s"}</span>
              </label>
              <dl className="divide-y divide-border/60">{section.rows.map((row, at) => <div key={`${row.label}-${at}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2">
                <dt className="text-[11px] text-muted-foreground">{row.label}</dt>
                <dd className="break-words text-right text-xs font-medium">{row.value}{row.note ? <span className="ml-1 text-[10px] font-normal text-muted-foreground">({row.note})</span> : null}</dd>
              </div>)}</dl>
            </div>)}

            {sheet.torques.length > 0 && <div className={`rounded-xl border ${torquesOn ? "border-primary/25" : "border-border"} bg-white`}>
              <label className="flex cursor-pointer items-center gap-3 border-b border-border/70 px-4 py-2.5">
                <Checkbox checked={torquesOn} onCheckedChange={value => setTorquesOn(value === true)} />
                <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-foreground"><Wrench size={13} />Tightening torques</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{sheet.torques.length} fasteners</span>
              </label>
              <div className="max-h-[22vh] divide-y divide-border/60 overflow-y-auto">{sheet.torques.map((spec, index) => <div key={`${spec.fastener}-${spec.stage}-${index}`} className="flex items-baseline justify-between gap-4 px-4 py-2">
                <span className="break-words text-xs">{spec.fastener}{spec.stage ? <span className="ml-1 text-[10px] text-muted-foreground">stage {spec.stage}</span> : null}</span>
                <span className="shrink-0 text-xs font-semibold text-primary">{spec.value} {spec.unit}</span>
              </div>)}</div>
            </div>}

            {sheet.repairTimes.length > 0 && <div className={`rounded-xl border ${timesOn ? "border-primary/25" : "border-border"} bg-white`}>
              <label className="flex cursor-pointer items-center gap-3 border-b border-border/70 px-4 py-2.5">
                <Checkbox checked={timesOn} onCheckedChange={value => setTimesOn(value === true)} />
                <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-foreground"><Clock size={13} />Repair times</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{sheet.repairTimes.length} operations</span>
              </label>
              <div className="max-h-[22vh] divide-y divide-border/60 overflow-y-auto">{sheet.repairTimes.map((row, index) => <div key={`${row.operation}-${index}`} className="px-4 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="break-words text-xs">{row.operation}</span>
                  <span className="shrink-0 text-xs font-semibold text-primary">{formatMinutes(row.minutes)}</span>
                </div>
                {row.combinedWith?.length ? <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">Can be combined with {row.combinedWith.join(", ")}{row.timeSavingMinutes ? ` · saves about ${formatMinutes(row.timeSavingMinutes)}` : ""}</p> : null}
              </div>)}</div>
            </div>}

            {sheet.sources.length > 0 && <div className="rounded-xl border border-border px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Sources read by Groq</p>
              <div className="mt-2 space-y-1.5">{sheet.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-1.5 text-[11px] font-semibold text-primary hover:underline"><ExternalLink size={12} className="mt-0.5 shrink-0" /><span className="break-all">{source.title}</span></a>)}</div>
            </div>}
          </div>

          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-900"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><p>AI-generated specifications and times can be wrong, incomplete or out of date. Check torques, times and safety-critical values against an authorised source before using them.</p></div>
        </>}

        {!loading && !error && !cancelled && !sheet && <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Sparkles size={22} className="mx-auto text-muted-foreground" />
          <p className="mt-3 text-sm font-semibold">Groq returned no usable specifications.</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">Add the engine model, engine number or year to the vehicle and try again, or paste a sheet from your program.</p>
          <Button variant="outline" onClick={() => run()} className="mt-3 h-9 rounded-lg text-xs">Try again</Button>
        </div>}

        {!loading && !error && cancelled && <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Sparkles size={22} className="mx-auto text-muted-foreground" />
          <p className="mt-3 text-sm font-semibold">Lookup cancelled.</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">Nothing was saved. You can retry the lookup or close this dialog.</p>
          <Button variant="outline" onClick={() => run()} className="mt-3 h-9 rounded-lg text-xs">Try again</Button>
        </div>}

        {saveError && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-xs text-destructive">{saveError}</p>}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-5">
          <p className="text-[11px] text-muted-foreground">{sheet && !loading && !error ? `${chosen.length} of ${sheet.sections.length} sections${chosenTorques ? ` · ${chosenTorques} torques` : ""}${chosenTimes ? ` · ${chosenTimes} repair times` : ""}` : ""}</p>
          <div className="flex gap-2"><Button type="button" variant="outline" disabled={saving} onClick={cancel} className="h-10 rounded-lg px-4 text-xs">{loading ? "Cancel lookup" : "Cancel"}</Button><Button type="button" disabled={saving || total === 0} onClick={save} className="h-10 rounded-lg px-5 text-xs">{saving && <Loader2 size={14} className="mr-1.5 animate-spin" />}Save {total || ""} selected</Button></div>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
