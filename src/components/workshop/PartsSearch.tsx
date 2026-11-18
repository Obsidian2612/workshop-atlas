import { useEffect, useState } from "react";
import { Check, ExternalLink, Globe, Loader2, Package, Plus, Search, ShieldAlert } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/workshop-api";
import type { PartSearchResponse, PartSearchResult, Workspace } from "@/lib/workshop-types";
import { Pick } from "./primitives";
import { toast } from "sonner";

/*
 * The counter knows the part as "clutch kit"; this dialog asks Groq to search the
 * workshop's own suppliers for it and shows what each shop lists, with the
 * price, the number and the page's own picture. Nothing is written until a row is
 * added, and every added part keeps the page it came from in its notes.
 */
function Thumb({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-border bg-background/60 text-muted-foreground"><Package size={22} strokeWidth={1.6} /></span>;
  return <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="h-20 w-20 shrink-0 rounded-xl border border-border bg-white object-contain p-1" />;
}

export default function PartsSearch({ data, term, vehicleId, close, refresh }: { data: Workspace; term: string; vehicleId: string; close: () => void; refresh: () => Promise<void> }) {
  const [query, setQuery] = useState(term);
  const [vehicle, setVehicle] = useState(vehicleId || "none");
  const [result, setResult] = useState<PartSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState("");
  const [added, setAdded] = useState<Record<string, boolean>>({});
  // A shop the search found but the workshop does not list yet. Adding it once
  // makes every row from that shop orderable.
  const [shops, setShops] = useState<Record<string, { id: string; name: string }>>({});
  const [addingShop, setAddingShop] = useState("");
  const configuredError = /GROQ_API_KEY/i.test(error);
  const results = result?.results ?? [];

  useEffect(() => { if (term.trim().length >= 2) void run(term); }, []);

  async function run(search: string) {
    const trimmed = search.replace(/\s+/g, " ").trim();
    if (trimmed.length < 2) { setError("Type the name of the part, for example clutch kit or dipstick"); return; }
    setLoading(true); setError(""); setResult(null); setAdded({});
    try {
      setResult(await api<PartSearchResponse>("parts-search", { term: trimmed, vehicleId: vehicle === "none" ? "" : vehicle }));
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  const inPartsList = (row: PartSearchResult) => data.records.some(record => record.kind === "part"
    && record.title.toLowerCase() === row.title.toLowerCase()
    && (record.partNumber || "").toLowerCase() === row.partNumber.toLowerCase());

  const shopOf = (row: PartSearchResult) => shops[row.website] || (row.supplierId ? { id: row.supplierId, name: row.supplierName } : undefined);
  const supplierIdOf = (row: PartSearchResult) => shopOf(row)?.id || "";
  const supplierNameOf = (row: PartSearchResult) => data.suppliers.find(supplier => supplier.id === supplierIdOf(row))?.name || shopOf(row)?.name || row.supplierName;

  async function addShop(row: PartSearchResult) {
    setAddingShop(row.website);
    try {
      const supplier = await api<{ id: string; name: string }>("suppliers", { action: "save", name: row.supplierName, website: row.website, searchUrl: "", nameSearchUrl: "" });
      setShops(current => ({ ...current, [row.website]: { id: supplier.id, name: supplier.name } }));
      await refresh();
      toast.success(`Added ${supplier.name} to your suppliers. This part can be ordered from it now.`);
    } catch (e) { toast.error((e as Error).message); }
    finally { setAddingShop(""); }
  }

  async function add(row: PartSearchResult) {
    const supplierId = supplierIdOf(row);
    if (!supplierId) { toast.info(`Add ${supplierNameOf(row)} as a supplier first, then add the part.`); return; }
    setAdding(row.url);
    try {
      // The page and the price travel with the part, so the order can be checked later.
      const content = [row.price ? `Price seen at ${supplierNameOf(row)}: ${row.price}` : "", row.snippet, `Source: ${row.url}`].filter(Boolean).join("\n");
      await api("records", {
        entity: "record", action: "save", kind: "part",
        title: row.title, partNumber: row.partNumber, partMake: row.partMake, supplierId,
        vehicleId: vehicle === "none" ? "" : vehicle, content,
      });
      setAdded(current => ({ ...current, [row.url]: true }));
      await refresh();
      toast.success(`Added ${row.title} to the parts list`);
    } catch (e) { toast.error((e as Error).message); }
    finally { setAdding(""); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !adding) close(); }}>
    <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto rounded-2xl border-border bg-white p-6 sm:rounded-2xl sm:p-8">
      <DialogHeader>
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Globe size={22} /></span>
        <DialogTitle className="font-heading text-2xl font-bold">Search the suppliers</DialogTitle>
        <DialogDescription className="pt-1 leading-6">Type what the part is called on the floor — clutch kit, dipstick — and Groq searches {data.suppliers.length === 1 ? data.suppliers[0].name : "the suppliers listed in this workshop"} and other shops it finds for what they stock. A shop you do not list yet can be added from its row, and nothing is saved until you add a row.</DialogDescription>
      </DialogHeader>

      <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void run(query); }}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <Label htmlFor="part-search-term" className="mb-2 block text-xs font-semibold">Part name</Label>
            <div className="relative"><Search size={15} className="absolute left-3 top-3.5 text-muted-foreground" /><Input id="part-search-term" autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="e.g. clutch kit, dipstick, oil filter" maxLength={100} className="h-11 rounded-lg bg-background/70 pl-9 text-sm" /></div>
          </div>
          <div className="w-[190px]">
            <Label className="mb-2 block text-xs font-semibold">For which vehicle?</Label>
            <Pick label="Search for a vehicle" value={vehicle} onChange={setVehicle} options={[{ value: "none", label: "Any vehicle" }, ...data.vehicles.map(item => ({ value: item.id, label: `${item.make} ${item.model}${item.year ? ` ${item.year}` : ""}` }))]} />
          </div>
          <Button type="submit" disabled={loading} className="h-11 rounded-lg px-5 text-xs">{loading ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Search size={14} className="mr-2" />}Search</Button>
        </div>
      </form>

      <div className="mt-4 space-y-4">
        {loading && <div className="flex items-center justify-center gap-3 rounded-xl border border-border bg-background/60 py-12 text-sm text-muted-foreground"><Loader2 size={19} className="animate-spin text-primary" />Searching the suppliers…</div>}

        {!loading && error && <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">{error}</p>
          {configuredError && <p className="mt-2 text-[11px] leading-5 text-muted-foreground">An administrator can enable this search by setting <code className="rounded bg-white px-1">GROQ_API_KEY</code> in the server environment, then restarting the app. Create a key at <a className="font-semibold text-primary underline" href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">console.groq.com/keys</a>.</p>}
          {!configuredError && <Button variant="outline" onClick={() => void run(query)} className="mt-3 h-9 rounded-lg text-xs">Try again</Button>}
        </div>}

        {!loading && !error && result && <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-background/60 px-4 py-3">
            <div className="min-w-0"><p className="text-xs font-semibold">{results.length} part{results.length === 1 ? "" : "s"} found</p><p className="mt-1 truncate text-[11px] text-muted-foreground">“{result.query}”{result.vehicle ? ` · ${result.vehicle}` : ""}</p></div>
            <div className="flex items-center gap-2">{result.cached && <Badge variant="secondary" className="rounded-md bg-white px-2 py-1 text-[10px]">Cached</Badge>}<Badge variant="secondary" className="rounded-md bg-white px-2 py-1 text-[10px]">{result.provider}</Badge></div>
          </div>

          {results.length ? <div className="max-h-[48vh] space-y-2 overflow-y-auto pr-1">{results.map(row => {
            const done = added[row.url] || inPartsList(row);
            return <div key={`${row.url}|${row.partNumber}`} className="flex flex-wrap items-start gap-3 rounded-xl border border-border p-3">
              <Thumb src={row.imageUrl} alt={row.title} />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold leading-5">{row.title}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-foreground">
                  {row.partNumber || <span className="font-sans text-muted-foreground">No number shown</span>}
                  {row.partMake && <span className="rounded bg-background px-1.5 py-0.5 font-sans text-[10px] font-semibold text-muted-foreground">{row.partMake}</span>}
                </p>
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                  <span className="font-semibold text-foreground">{supplierNameOf(row)}</span>
                  {!supplierIdOf(row) && <span className="rounded bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-800">Not in your suppliers</span>}
                  {row.price && <span className="font-semibold text-primary">{row.price}</span>}
                  <a href={row.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">Open page<ExternalLink size={10} /></a>
                </p>
                {row.snippet && <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-muted-foreground">{row.snippet}</p>}
              </div>
              {supplierIdOf(row) ? <Button type="button" variant={done ? "outline" : "default"} size="sm" disabled={done || adding === row.url} onClick={() => void add(row)} className="h-8 rounded-lg px-3 text-[11px]">
                {adding === row.url ? <Loader2 size={12} className="mr-1.5 animate-spin" /> : done ? <Check size={12} className="mr-1.5" /> : null}
                {done ? "In parts list" : "Add part"}
              </Button> : <Button type="button" variant="outline" size="sm" disabled={addingShop === row.website} onClick={() => void addShop(row)} title={`Add ${row.supplierName} as a supplier so this part can be ordered from it`} className="h-8 rounded-lg border-primary/20 bg-primary/5 px-3 text-[11px] font-semibold text-primary hover:bg-primary/10">
                {addingShop === row.website ? <Loader2 size={12} className="mr-1.5 animate-spin" /> : <Plus size={12} className="mr-1.5" />}
                Add shop
              </Button>}
            </div>;
          })}</div> : <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <Package size={22} className="mx-auto text-muted-foreground" />
            <p className="mt-3 text-sm font-semibold">No shop listed a part under that name.</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">Try the name the shops use — “clutch kit 3 piece”, “oil filter”, “wiper blade” — or choose the vehicle so the search can match the fitment.</p>
          </div>}

          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-900"><ShieldAlert size={15} className="mt-0.5 shrink-0" /><p>Numbers, prices and fitment come from the suppliers' own pages and can be out of date. Check the part against the vehicle before ordering.</p></div>
        </>}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-5">
          <p className="text-[11px] text-muted-foreground">{!loading && !error && results.length ? `${results.filter(row => added[row.url] || inPartsList(row)).length} of ${results.length} in your parts list` : ""}</p>
          <Button type="button" variant="outline" disabled={Boolean(adding)} onClick={close} className="h-10 rounded-lg px-4 text-xs">Done</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
