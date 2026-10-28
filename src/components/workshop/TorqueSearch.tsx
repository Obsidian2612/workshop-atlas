import { useEffect, useState } from "react";
import { ExternalLink, Globe, Loader2, Search, ShieldAlert } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/workshop-api";
import type { TorqueSearchCandidate, TorqueSearchResponse, Vehicle } from "@/lib/workshop-types";
import { toast } from "sonner";

const candidateKey = (candidate: TorqueSearchCandidate) => `${candidate.fastener}\u0000${candidate.stage}\u0000${candidate.value}\u0000${candidate.unit}`;

function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return "source"; }
}

/*
 * Two-step lookup: search, then review. The server reads a few result pages and
 * returns parsed fastener rows; this dialog writes nothing until the user picks
 * rows and confirms. Values come from third-party pages, so the warning stays
 * visible while the rows are reviewed.
 */
export default function TorqueSearch({ vehicle, close, refresh }: { vehicle: Vehicle; close: () => void; refresh: () => Promise<void> }) {
  const [data, setData] = useState<TorqueSearchResponse | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const candidates = data?.candidates ?? [];
  const chosen = candidates.filter(candidate => selected[candidateKey(candidate)]);
  const configuredError = /GROQ_API_KEY/i.test(error);

  useEffect(() => { void run(); }, [vehicle.id]);

  async function run() {
    setLoading(true); setError(""); setSaveError(""); setData(null);
    try {
      const result = await api<TorqueSearchResponse>("torque-search", { vehicleId: vehicle.id });
      setData(result);
      setSelected(Object.fromEntries(result.candidates.map(candidate => [candidateKey(candidate), true])));
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  async function addSelected() {
    if (!data || !chosen.length) return;
    setSaving(true); setSaveError("");
    try {
      await api("torques", {
        vehicleId: vehicle.id,
        action: "merge",
        specs: chosen.map(({ fastener, stage, value, unit }) => ({ fastener, stage, value, unit })),
      });
      await refresh();
      toast.success(`Added ${chosen.length} tightening torque row${chosen.length === 1 ? "" : "s"}`);
      close();
    } catch (e) { setSaveError((e as Error).message); }
    finally { setSaving(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !saving) close(); }}>
    <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto rounded-2xl border-border bg-white p-6 sm:rounded-2xl sm:p-8">
      <DialogHeader>
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Globe size={22} /></span>
        <DialogTitle className="font-heading text-2xl font-bold">Search tightening torques with Groq</DialogTitle>
        <DialogDescription className="pt-1 leading-6">Use Groq's web search to look up <span className="font-semibold text-foreground">{vehicle.year} {vehicle.make} {vehicle.model}{vehicle.engineModel || vehicle.engine ? ` · ${vehicle.engineModel || vehicle.engine}` : ""}</span>. Nothing is saved until you review the rows and add them.</DialogDescription>
      </DialogHeader>

      <div className="mt-3 space-y-4">
        {loading && <div className="flex items-center justify-center gap-3 rounded-xl border border-border bg-background/60 py-12 text-sm text-muted-foreground"><Loader2 size={19} className="animate-spin text-primary" />Searching the web with Groq…</div>}

        {!loading && error && <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">{error}</p>
          {configuredError && <p className="mt-2 text-[11px] leading-5 text-muted-foreground">An administrator can enable Groq by setting <code className="rounded bg-white px-1">GROQ_API_KEY</code> in the server environment, then restarting the app. Create a key at <a className="font-semibold text-primary underline" href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">console.groq.com/keys</a>.</p>}
          {!configuredError && <Button variant="outline" onClick={() => run()} className="mt-3 h-9 rounded-lg text-xs">Try again</Button>}
        </div>}

        {!loading && !error && data && <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-background/60 px-4 py-3">
            <div className="min-w-0"><p className="text-xs font-semibold">{data.candidates.length} candidate{data.candidates.length === 1 ? "" : "s"} · {data.results.length} cited source{data.results.length === 1 ? "" : "s"}</p><p className="mt-1 truncate text-[11px] text-muted-foreground">“{data.query}”</p></div>
            <div className="flex items-center gap-2">{data.cached && <Badge variant="secondary" className="rounded-md bg-white px-2 py-1 text-[10px]">Cached</Badge>}<Badge variant="secondary" className="rounded-md bg-white px-2 py-1 text-[10px] capitalize">{data.provider}</Badge></div>
          </div>

          {candidates.length ? <div className="max-h-[46vh] overflow-y-auto rounded-xl border border-border">
            <div className="divide-y divide-border">{candidates.map(candidate => {
              const key = candidateKey(candidate);
              return <label key={key} className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-background/60">
                <Checkbox checked={Boolean(selected[key])} onCheckedChange={value => setSelected(current => ({ ...current, [key]: value === true }))} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="break-words text-xs font-semibold">{candidate.fastener}</span>
                    <span className="shrink-0 text-xs font-bold text-primary">{candidate.value} {candidate.unit}</span>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                    {candidate.stage && <span>Stage {candidate.stage}</span>}
                    {candidate.mentions > 1 && <span>Seen {candidate.mentions} times</span>}
                    <a href={candidate.sourceUrl} target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">{hostOf(candidate.sourceUrl)}<ExternalLink size={10} /></a>
                  </span>
                  <span className="mt-1 block line-clamp-2 text-[10px] leading-4 text-muted-foreground">{candidate.snippet}</span>
                </span>
              </label>;
            })}</div>
          </div> : <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <Search size={22} className="mx-auto text-muted-foreground" />
            <p className="mt-3 text-sm font-semibold">No torque values were recognised.</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">Pages often show ranges, pictures or headings only. Open a result, copy its torque table, and use <span className="font-semibold text-foreground">Paste from the program</span> for a manual review.</p>
          </div>}

          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-900"><ShieldAlert size={15} className="mt-0.5 shrink-0" /><p>Third-party values can be wrong, incomplete or out of date. Check them against an authorised source before tightening safety-critical fasteners.</p></div>
          {saveError && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-xs text-destructive">{saveError}</p>}

          <div className="rounded-xl border border-border">
            <p className="border-b border-border bg-background/70 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Sources cited by Groq</p>
            <div className="max-h-36 divide-y divide-border overflow-y-auto">{data.results.map(result => <a key={result.url} href={result.url} target="_blank" rel="noopener noreferrer" className="block px-4 py-2.5 hover:bg-background"><span className="flex items-center justify-between gap-3"><span className="min-w-0 truncate text-xs font-medium">{result.title}</span><ExternalLink size={12} className="shrink-0 text-primary" /></span><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{hostOf(result.url)}</span></a>)}</div>
          </div>
        </>}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-5">
          <p className="text-[11px] text-muted-foreground">{!loading && !error && candidates.length > 0 ? `${chosen.length} of ${candidates.length} selected` : ""}</p>
          <div className="flex gap-2"><Button type="button" variant="outline" disabled={saving} onClick={close} className="h-10 rounded-lg px-4 text-xs">Cancel</Button><Button type="button" disabled={saving || !chosen.length} onClick={addSelected} className="h-10 rounded-lg px-5 text-xs">{saving && <Loader2 size={14} className="mr-1.5 animate-spin" />}Add {chosen.length || ""} selected</Button></div>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
