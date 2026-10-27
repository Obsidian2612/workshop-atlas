import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Wrench } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/workshop-api";
import type { GeminiTorqueRow, Vehicle } from "@/lib/workshop-types";
import { toast } from "sonner";

const rowKey = (row: GeminiTorqueRow) => `${row.fastener}\u0000${row.stage}\u0000${row.value}\u0000${row.unit}`;

/*
 * Two-step torque lookup: Gemini returns candidate fasteners, the reader picks
 * the rows they trust, and only those rows are merged into the vehicle.
 */
export default function GeminiTorques({ vehicle, close, refresh }: { vehicle: Vehicle; close: () => void; refresh: () => Promise<void> }) {
  const [rows, setRows] = useState<GeminiTorqueRow[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const chosen = rows.filter(row => selected[rowKey(row)]);
  const unconfigured = /GEMINI_API_KEY/.test(error);

  useEffect(() => { void run(); }, [vehicle.id]);

  async function run() {
    setLoading(true); setError(""); setSaveError(""); setRows([]);
    try {
      const result = await api<{ specs: GeminiTorqueRow[] }>("gemini", { vehicleId: vehicle.id, kind: "torques" });
      setRows(result.specs);
      setSelected(Object.fromEntries(result.specs.map(row => [rowKey(row), true])));
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  async function addSelected() {
    if (!chosen.length) return;
    setSaving(true); setSaveError("");
    try {
      await api("torques", {
        vehicleId: vehicle.id,
        action: "merge",
        specs: chosen.map(({ fastener, stage, value, unit }) => ({ fastener, stage, value, unit })),
      });
      await refresh();
      toast.success(`Added ${chosen.length} tightening torque${chosen.length === 1 ? "" : "s"} from Gemini`);
      close();
    } catch (e) { setSaveError((e as Error).message); }
    finally { setSaving(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !saving) close(); }}>
    <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto rounded-2xl border-border bg-white p-6 sm:rounded-2xl sm:p-8">
      <DialogHeader>
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Wrench size={22} /></span>
        <DialogTitle className="font-heading text-2xl font-bold">Look up tightening torques with Gemini</DialogTitle>
        <DialogDescription className="pt-1 leading-6">
          Ask Google Gemini for torque specifications on <span className="font-semibold text-foreground">{vehicle.make} {vehicle.model}{vehicle.year ? ` ${vehicle.year}` : ""}{(vehicle.engineModel || vehicle.engine) ? ` · ${vehicle.engineModel || vehicle.engine}` : ""}</span>{vehicle.vin ? <> using VIN <span className="font-mono text-foreground">{vehicle.vin}</span></> : null}. Nothing is saved until you review the rows and add them.
        </DialogDescription>
      </DialogHeader>

      <div className="mt-3 space-y-4">
        {loading && <div className="flex items-center justify-center gap-3 rounded-xl border border-border bg-background/60 py-12 text-sm text-muted-foreground"><Loader2 size={19} className="animate-spin text-primary" />Asking Gemini…</div>}

        {!loading && error && <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">{error}</p>
          {unconfigured && <p className="mt-2 text-[11px] leading-5 text-muted-foreground">An administrator can enable this by setting <code className="rounded bg-white px-1">GEMINI_API_KEY</code> in the server environment and restarting the app. Optionally set <code className="rounded bg-white px-1">GEMINI_MODEL</code>; the default is <code className="rounded bg-white px-1">gemini-2.5-flash</code>.</p>}
          {!unconfigured && <Button variant="outline" onClick={() => run()} className="mt-3 h-9 rounded-lg text-xs">Try again</Button>}
        </div>}

        {!loading && !error && rows.length > 0 && <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-background/60 px-4 py-3">
            <div><p className="text-xs font-semibold">{rows.length} fastener{rows.length === 1 ? "" : "s"}</p><p className="mt-1 text-[11px] text-muted-foreground">{chosen.length} selected</p></div>
            <Badge variant="secondary" className="rounded-md bg-white px-2 py-1 text-[10px]">Gemini</Badge>
          </div>

          <div className="max-h-[46vh] overflow-y-auto rounded-xl border border-border">
            <div className="divide-y divide-border">{rows.map(row => {
              const key = rowKey(row);
              return <label key={key} className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-background/60">
                <Checkbox checked={Boolean(selected[key])} onCheckedChange={value => setSelected(current => ({ ...current, [key]: value === true }))} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="break-words text-xs font-semibold">{row.fastener}</span>
                    <span className="shrink-0 text-xs font-bold text-primary">{row.value} {row.unit}</span>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                    {row.stage && <span>Stage {row.stage}</span>}
                    {row.vin && <span className="truncate font-mono">{row.vin}</span>}
                  </span>
                </span>
              </label>;
            })}</div>
          </div>

          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-900"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><p>AI-generated torques can be wrong, incomplete or out of date. Check them against an authorised source before tightening safety-critical fasteners.</p></div>
        </>}

        {!loading && !error && rows.length === 0 && <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Wrench size={22} className="mx-auto text-muted-foreground" />
          <p className="mt-3 text-sm font-semibold">Gemini returned no tightening torques.</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">Add the engine or model to the vehicle and try again, use the online search, or paste a torque table from the program.</p>
          <Button variant="outline" onClick={() => run()} className="mt-3 h-9 rounded-lg text-xs">Try again</Button>
        </div>}

        {saveError && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-xs text-destructive">{saveError}</p>}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-5">
          <p className="text-[11px] text-muted-foreground">{!loading && !error && rows.length > 0 ? `${chosen.length} of ${rows.length} selected` : ""}</p>
          <div className="flex gap-2"><Button type="button" variant="outline" disabled={saving} onClick={close} className="h-10 rounded-lg px-4 text-xs">Cancel</Button><Button type="button" disabled={saving || !chosen.length} onClick={addSelected} className="h-10 rounded-lg px-5 text-xs">{saving && <Loader2 size={14} className="mr-1.5 animate-spin" />}Add {chosen.length || ""} selected</Button></div>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
