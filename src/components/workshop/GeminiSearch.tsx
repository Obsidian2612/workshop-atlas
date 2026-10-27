import { useEffect, useState } from "react";
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
 * Two-step lookup: Gemini returns candidate repair times, the reader reviews
 * them here, and only the selected rows are written to the vehicle.
 */
export default function GeminiSearch({ vehicle, close, refresh }: { vehicle: Vehicle; close: () => void; refresh: () => Promise<void> }) {
  const [rows, setRows] = useState<GeminiRepairRow[]>([]);
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
      const result = await api<{ operations: GeminiRepairRow[] }>("gemini", { vehicleId: vehicle.id });
      setRows(result.operations);
      setSelected(Object.fromEntries(result.operations.map(row => [rowKey(row), true])));
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  async function addSelected() {
    if (!chosen.length) return;
    setSaving(true); setSaveError("");
    try {
      await api("gemini", {
        vehicleId: vehicle.id,
        apply: true,
        operations: chosen.map(({ operation, minutes }) => ({ operation, minutes })),
      });
      await refresh();
      toast.success(`Added ${chosen.length} repair time${chosen.length === 1 ? "" : "s"} from Gemini`);
      close();
    } catch (e) { setSaveError((e as Error).message); }
    finally { setSaving(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !saving) close(); }}>
    <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto rounded-2xl border-border bg-white p-6 sm:rounded-2xl sm:p-8">
      <DialogHeader>
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Sparkles size={22} /></span>
        <DialogTitle className="font-heading text-2xl font-bold">Look up repair times with Gemini</DialogTitle>
        <DialogDescription className="pt-1 leading-6">
          Ask Google Gemini for workshop times on <span className="font-semibold text-foreground">{vehicle.make} {vehicle.model}{vehicle.year ? ` ${vehicle.year}` : ""}</span>{vehicle.vin ? <> using VIN <span className="font-mono text-foreground">{vehicle.vin}</span></> : null}. Nothing is saved until you review the rows and add them.
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
            <div><p className="text-xs font-semibold">{rows.length} candidate{rows.length === 1 ? "" : "s"}</p><p className="mt-1 text-[11px] text-muted-foreground">{chosen.length} selected · {formatMinutes(chosen.reduce((sum, row) => sum + row.minutes, 0))}</p></div>
            <Badge variant="secondary" className="rounded-md bg-white px-2 py-1 text-[10px]">Gemini</Badge>
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
                  <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{row.vin}</span>
                </span>
              </label>;
            })}</div>
          </div>

          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-900"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><p>AI-generated times are estimates and can be wrong or out of date. Check them against an authorised repair-time source before using them for quotes or billing.</p></div>
        </>}

        {!loading && !error && rows.length === 0 && <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Sparkles size={22} className="mx-auto text-muted-foreground" />
          <p className="mt-3 text-sm font-semibold">Gemini returned no repair times.</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">Add the engine or model to the vehicle and try again, or paste times from your repair-time program.</p>
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
