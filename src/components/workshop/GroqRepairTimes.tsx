import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Clock, Loader2, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/workshop-api";
import type { GeminiRepairRow, Vehicle } from "@/lib/workshop-types";
import { toast } from "sonner";

const rowKey = (row: GeminiRepairRow) => `${row.operation}\u0000${row.minutes}`;
const formatMinutes = (minutes: number) => minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;

/*
 * Two-step lookup: Groq returns candidate repair times and overlap notes, the
 * reader reviews them here, and only the selected rows are written to the vehicle.
 */
export default function GroqRepairTimes({ vehicle, close, refresh }: { vehicle: Vehicle; close: () => void; refresh: () => Promise<void> }) {
  const [rows, setRows] = useState<GroqRepairRow[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [cancelled, setCancelled] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const chosen = rows.filter(row => selected[rowKey(row)]);
  const unconfigured = /GROQ_API_KEY/.test(error);

  useEffect(() => { void run(); }, [vehicle.id]);
  useEffect(() => () => { controller.current?.abort(); }, []);

  async function run() {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setLoading(true); setError(""); setSaveError(""); setCancelled(false); setRows([]);
    try {
      const result = await api<{ operations: GroqRepairRow[] }>("groq-repair-times", { vehicleId: vehicle.id }, active.signal);
      if (active.signal.aborted) return;
      setRows(result.operations);
      setSelected(Object.fromEntries(result.operations.map(row => [rowKey(row), true])));
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

  async function addSelected() {
    if (!chosen.length) return;
    setSaving(true); setSaveError("");
    try {
      await api("groq-repair-times", {
        vehicleId: vehicle.id,
        apply: true,
        operations: chosen.map(({ operation, minutes }) => ({ operation, minutes })),
      });
      await refresh();
      toast.success(`Added ${chosen.length} repair time${chosen.length === 1 ? "" : "s"} from Groq`);
      close();
    } catch (e) { setSaveError((e as Error).message); }
    finally { setSaving(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !saving) dismiss(); }}>
    <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto rounded-2xl border-border bg-white p-6 sm:rounded-2xl sm:p-8">
      <DialogHeader>
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Sparkles size={22} /></span>
        <DialogTitle className="font-heading text-2xl font-bold">Look up repair times with Groq</DialogTitle>
        <DialogDescription className="pt-1 leading-6">
          Ask Groq to search for workshop times on <span className="font-semibold text-foreground">{vehicle.make} {vehicle.model}{vehicle.year ? ` ${vehicle.year}` : ""}</span>{vehicle.vin ? <> using VIN <span className="font-mono text-foreground">{vehicle.vin}</span></> : null}. Nothing is saved until you review the rows and add them.
        </DialogDescription>
      </DialogHeader>

      <div className="mt-3 space-y-4">
        {loading && <div className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-border bg-background/60 px-4 py-12 text-sm text-muted-foreground"><Loader2 size={19} className="animate-spin text-primary" />Searching web with Groq…<Button type="button" variant="outline" onClick={cancel} className="h-8 rounded-lg px-3 text-xs">Cancel</Button></div>}

        {!loading && error && <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">{error}</p>
          {unconfigured && <p className="mt-2 text-[11px] leading-5 text-muted-foreground">An administrator can enable this by setting <code className="rounded bg-white px-1">GROQ_API_KEY</code> in the server environment and restarting the app. The default model is <code className="rounded bg-white px-1">openai/gpt-oss-20b</code>.</p>}
          {!unconfigured && <Button variant="outline" onClick={() => run()} className="mt-3 h-9 rounded-lg text-xs">Try again</Button>}
        </div>}

        {!loading && !error && rows.length > 0 && <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-background/60 px-4 py-3">
            <div><p className="text-xs font-semibold">{rows.length} candidate{rows.length === 1 ? "" : "s"}</p><p className="mt-1 text-[11px] text-muted-foreground">{chosen.length} selected · {formatMinutes(chosen.reduce((sum, row) => sum + row.minutes, 0))}</p></div>
            <Badge variant="secondary" className="rounded-md bg-white px-2 py-1 text-[10px]">Groq · {rows.reduce((count, row) => count + (row.combinedWith?.length || 0), 0)} overlap links</Badge>
          </div>

          <div className="max-h-[46vh] overflow-y-auto rounded-xl border border-border">
            <div className="divide-y divide-border">{rows.map(row => {
              const key = rowKey(row);
              return <label key={key} className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-background/60">
                <Checkbox checked={Boolean(selected[key])} onCheckedChange={value => setSelected(current => ({ ...current, [key]: value === true }))} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="break-words text-xs font-semibold">{row.operation}</span>
                    <span className="flex shrink-0 items-center gap-1 text-xs font-bold text-primary"><Clock size={12} />{formatMinutes(row.minutes)}</span>
                  </span>
                  {row.combinedWith?.length ? <span className="mt-1 block text-[10px] leading-4 text-muted-foreground">Can be combined with {row.combinedWith.join(", ")}{row.timeSavingMinutes ? ` · saves about ${formatMinutes(row.timeSavingMinutes)}` : ""}</span> : null}
                </span>
              </label>;
            })}</div>
          </div>

          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-900"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><p>AI-generated times are estimates and can be wrong or out of date. Check them against an authorised repair-time source before using them for quotes or billing.</p></div>
        </>}

        {!loading && !error && !cancelled && rows.length === 0 && <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Sparkles size={22} className="mx-auto text-muted-foreground" />
          <p className="mt-3 text-sm font-semibold">Groq returned no repair times.</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">Add the engine or model to the vehicle and try again, or paste times from your repair-time program.</p>
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
          <p className="text-[11px] text-muted-foreground">{!loading && !error && rows.length > 0 ? `${chosen.length} of ${rows.length} selected` : ""}</p>
          <div className="flex gap-2"><Button type="button" variant="outline" disabled={saving} onClick={cancel} className="h-10 rounded-lg px-4 text-xs">{loading ? "Cancel lookup" : "Cancel"}</Button><Button type="button" disabled={saving || !chosen.length} onClick={addSelected} className="h-10 rounded-lg px-5 text-xs">{saving && <Loader2 size={14} className="mr-1.5 animate-spin" />}Add {chosen.length || ""} selected</Button></div>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
