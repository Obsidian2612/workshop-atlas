import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, BookOpen, CarFront, ChevronDown, CircleHelp, History, Loader2, Menu, Plus, Search, Server, ShieldCheck, StickyNote, X, RefreshCw, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogCancel } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { api, useWorkspace } from "@/lib/workshop-api";
import { sectionTitles, type Section } from "@/lib/workshop-types";
import Sidebar from "@/components/workshop/Sidebar";
import Overview from "@/components/workshop/Overview";
import Library from "@/components/workshop/Library";
import AuthDialog from "@/components/workshop/AuthDialog";
import RecordEditor, { type EditorTarget } from "@/components/workshop/RecordEditor";
import RecordDetail, { type DetailTarget } from "@/components/workshop/RecordDetail";
import UploadDialog from "@/components/workshop/UploadDialog";
import Settings from "@/components/workshop/Settings";
import Legacy from "@/components/workshop/Legacy";
import GlobalSearch from "@/components/workshop/GlobalSearch";
import { cn } from "@/lib/utils";

const descriptions: Record<Section, string> = {
  overview: "A clear view of your vehicles, your knowledge, and what comes next.",
  vehicles: "Every vehicle's specifications, notes and history. Together.",
  procedures: "The steps and specifications your team can return to.",
  notes: "Turn hands-on experience into your workshop's shared knowledge.",
  history: "A reliable record of every visit and the work performed.",
  attachments: "Documents and photos, right alongside the records they belong to.",
  legacy: "Your original software, kept separate from your new workspace.",
  settings: "Your workshop, your team, and the right level of access.",
};
export default function Index() {
  const { data, loading, error, refresh } = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const section = (location.pathname.slice(1) || "overview") as Section;
  const [menuOpen, setMenuOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [upload, setUpload] = useState<{ recordId?: string } | null>(null);
  const [deletion, setDeletion] = useState<{ entity: string; id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const canEdit = Boolean(data.user && data.user.role !== "viewer");
  useEffect(() => { setQuery(""); setMenuOpen(false); }, [location.pathname]);
  useEffect(() => { if (!data.user) { setEditor(null); setDetail(null); setUpload(null); setDeletion(null); } }, [data.user?.id]);
  function create(target: EditorTarget) {
    if (!data.user) { setAuthOpen(true); return; }
    if (!canEdit) { toast.info("Your account is read-only. Ask an administrator for editor access."); return; }
    setDetail(null); setEditor(target);
  }
  function addUpload(recordId?: string) {
    if (!data.user) { setAuthOpen(true); return; }
    if (!canEdit) { toast.info("An editor account is needed to upload files."); return; }
    setDetail(null); setUpload({ recordId });
  }
  const askDelete = (entity: string, id: string, title: string) => setDeletion({ entity, id, title });
  async function remove() {
    if (!deletion) return; setDeleting(true);
    try {
      await api(deletion.entity === "user" ? "users" : "records", { ...deletion, action: "delete" });
      setDetail(null); setDeletion(null); await refresh(); toast.success("Deleted successfully");
    } catch (e) { toast.error((e as Error).message); } finally { setDeleting(false); }
  }
  const auth = () => setAuthOpen(true);
  const pageLabel = section === "overview" ? "Overview" : sectionTitles[section];
  const date = new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const mainAction = section === "vehicles" ? "Add vehicle" : section === "procedures" ? "Add procedure" : section === "notes" ? "Write a note" : section === "history" ? "Log service" : section === "attachments" ? "Upload file" : "Add record";
  function primaryAction() {
    if (section === "attachments") addUpload();
    else if (section === "vehicles") create({ entity: "vehicle" });
    else create({ entity: "record", kind: section === "notes" ? "note" : section === "history" ? "service" : "procedure" });
  }
  return <div className="min-h-screen bg-background">
    <Sidebar data={data} open={menuOpen} close={() => setMenuOpen(false)} onAuth={auth} />
    <div className="lg:ml-[244px]">
      <header className="sticky top-0 z-30 flex h-[76px] items-center gap-3 border-b border-border bg-white/95 px-4 backdrop-blur-sm sm:px-7 xl:px-9"><Button variant="ghost" size="icon" onClick={() => setMenuOpen(true)} aria-label="Open navigation" className="h-9 w-9 shrink-0 rounded-lg lg:hidden"><Menu size={20} /></Button><div className="hidden items-center gap-2 text-[11px] sm:flex"><span className="text-muted-foreground">Workspace</span><span className="px-1 text-muted-foreground/40">/</span><span className="whitespace-nowrap font-semibold">{pageLabel}</span></div>
        <div className="relative ml-auto flex-1 sm:ml-6 sm:max-w-[370px] xl:ml-auto"><Search size={16} className="absolute left-3.5 top-3 text-muted-foreground" /><Input aria-label="Search all workshop information" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Escape") setQuery(""); }} placeholder="Search your workshop…" className="h-10 rounded-lg border-border/70 bg-background/80 pl-10 pr-9 text-xs shadow-none placeholder:text-muted-foreground" />{query && <button aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-3 top-3 text-muted-foreground"><X size={14} /></button>}</div>
        <div className="ml-2 hidden items-center gap-2 border-r border-border pr-4 xl:flex"><span className={cn("h-1.5 w-1.5 rounded-full", error ? "bg-amber-500" : loading ? "bg-slate-400" : "bg-primary")} /><span className="whitespace-nowrap text-[10px] text-muted-foreground">{error ? "Server unavailable" : loading ? "Connecting…" : "Server connected"}</span></div><Button variant="ghost" size="icon" onClick={() => setHelpOpen(true)} aria-label="Open quick guide" className="hidden h-9 w-9 shrink-0 rounded-lg text-muted-foreground sm:inline-flex"><CircleHelp size={19} strokeWidth={1.7} /></Button><button onClick={auth} aria-label={data.user ? "Account and sign out" : "Sign in or set up workshop"} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/10 bg-[#e7efeb] text-[10px] font-bold text-primary">{data.user ? data.user.name.split(" ").map(s => s[0]).slice(0, 2).join("") : "WA"}</button>
      </header>
      <main className="mx-auto max-w-[1480px] px-4 pb-8 pt-7 sm:px-7 sm:pt-8 xl:px-9">
        <div className="mb-7 flex flex-wrap items-start justify-between gap-4"><div><p className="mb-2.5 text-[10px] font-semibold uppercase tracking-[1.7px] text-muted-foreground">{section === "overview" ? "A place for your workshop's know-how" : "Your shared workspace"}</p><h1 className="font-heading text-[25px] font-bold leading-tight tracking-[-0.8px] sm:text-[29px]">{section === "overview" ? "Your workshop, at a glance." : sectionTitles[section]}</h1><p className="mt-2.5 text-xs leading-6 text-muted-foreground">{descriptions[section]}</p></div><div className="flex items-center gap-3 pt-1"><span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground 2xl:flex"><CalendarDays size={14} />{date}</span>{(!data.user || canEdit) && <div className="flex"><Button onClick={section === "overview" ? () => create({ entity: "vehicle" }) : primaryAction} className="h-10 rounded-l-lg rounded-r-none border-r border-white/20 px-4 text-xs font-semibold shadow-sm"><Plus size={16} className="mr-2" />{mainAction}</Button><DropdownMenu><DropdownMenuTrigger asChild><Button aria-label="Choose record type to add" className="h-10 rounded-l-none rounded-r-lg px-2.5"><ChevronDown size={14} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-56 rounded-xl border-border bg-white p-2 shadow-xl"><DropdownMenuLabel className="px-2 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Add to your workshop</DropdownMenuLabel>{[{ title: "Vehicle", icon: CarFront, target: { entity: "vehicle" } as EditorTarget }, { title: "Service procedure", icon: BookOpen, target: { entity: "record", kind: "procedure" } as EditorTarget }, { title: "Repair note", icon: StickyNote, target: { entity: "record", kind: "note" } as EditorTarget }, { title: "Service entry", icon: History, target: { entity: "record", kind: "service" } as EditorTarget }].map(item => <DropdownMenuItem key={item.title} onSelect={() => create(item.target)} className="cursor-pointer gap-3 rounded-lg px-2 py-2.5 text-xs"><item.icon size={16} className="text-primary" />{item.title}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div>}</div></div>
        {error && <div role="alert" className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4"><Server size={18} className="text-amber-700" /><p className="flex-1 text-xs text-amber-900">Unable to reach workshop storage: {error}</p><Button onClick={() => refresh()} variant="outline" className="h-8 rounded-lg border-amber-200 bg-white text-xs"><RefreshCw size={12} className="mr-2" />Retry</Button></div>}
        {!loading && !data.user && !error && <div className="mb-6 flex flex-col gap-3 rounded-xl border border-primary/15 bg-white px-5 py-4 sm:flex-row sm:items-center"><ShieldCheck size={20} className="shrink-0 text-primary" /><div className="flex-1"><p className="text-xs font-semibold">{data.setupRequired ? "A fresh start for your workshop." : "Your team's knowledge is a sign-in away."}</p><p className="mt-1 text-[11px] leading-5 text-muted-foreground">{data.setupRequired ? "Create your administrator account to start adding vehicles and invite your team." : "Workshop records are private. Sign in to view your vehicles, notes and procedures."}</p></div><button onClick={auth} className="flex items-center gap-2 whitespace-nowrap text-xs font-bold text-primary">{data.setupRequired ? "Set up workspace" : "Sign in"}<ArrowRight size={14} /></button></div>}
        {loading ? <div className="flex min-h-[400px] items-center justify-center gap-3 text-sm text-muted-foreground"><Loader2 size={20} className="animate-spin text-primary" />Connecting to your workshop…</div> : query.trim() ? <GlobalSearch query={query} data={data} view={setDetail} clear={() => setQuery("")} /> : section === "overview" ? <Overview data={data} navigate={navigate} create={create} view={setDetail} onAuth={auth} /> : section === "settings" ? <Settings data={data} refresh={refresh} onAuth={auth} confirmDelete={askDelete} /> : section === "legacy" ? <Legacy data={data} onSettings={() => navigate("/settings")} /> : <Library key={section} section={section} data={data} create={create} view={setDetail} upload={() => addUpload()} remove={askDelete} />}
        <footer className="mt-7 flex flex-wrap items-center justify-between gap-2 border-t border-border/80 pt-5 text-[10px] text-muted-foreground"><p>Workshop Atlas <span className="mx-2 text-border">/</span>Independent knowledge. Connected team.</p><p className="flex items-center gap-1.5"><ShieldCheck size={12} />Workshop-owned data · Local server storage</p></footer>
      </main>
    </div>
    <AuthDialog open={authOpen} onOpenChange={setAuthOpen} data={data} refresh={refresh} />
    {editor && <RecordEditor key={editor.value?.id || `${editor.entity}-${editor.entity === "record" ? editor.kind : "new"}`} target={editor} close={() => setEditor(null)} data={data} refresh={refresh} />}
    {detail && <RecordDetail target={detail} data={data} close={() => setDetail(null)} edit={create} remove={askDelete} upload={addUpload} view={setDetail} refresh={refresh} />}
    {upload && <UploadDialog data={data} recordId={upload.recordId} close={() => setUpload(null)} refresh={refresh} />}
    <AlertDialog open={Boolean(deletion)} onOpenChange={open => { if (!open && !deleting) setDeletion(null); }}><AlertDialogContent className="rounded-2xl border-border bg-white p-7 sm:rounded-2xl"><AlertDialogHeader><AlertDialogTitle className="font-heading text-xl font-bold">Delete “{deletion?.title}”?</AlertDialogTitle><AlertDialogDescription className="pt-2 leading-6">{deletion?.entity === "vehicle" ? "This also deletes the vehicle's linked procedures, repair notes, service entries and attachments." : deletion?.entity === "user" ? "This account will lose access immediately. Workshop records they created will remain." : "This record and any linked attachments will be removed."} This cannot be undone.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter className="mt-3"><AlertDialogCancel disabled={deleting} className="rounded-lg">Cancel</AlertDialogCancel><Button disabled={deleting} variant="destructive" className="rounded-lg" onClick={remove}>{deleting && <Loader2 size={15} className="mr-2 animate-spin" />}Delete {deletion?.entity === "user" ? "account" : "record"}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}><DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto rounded-2xl border-border bg-white p-7 sm:rounded-2xl"><DialogHeader><DialogTitle className="font-heading text-2xl font-bold">A quick workshop guide.</DialogTitle><DialogDescription className="pt-2">A few useful things to know before getting started.</DialogDescription></DialogHeader><div className="space-y-5 pt-2">{[{ title: "Start with a vehicle", text: "Add its make, model, registration and your verified specifications. Open its detail view to link service entries and files." }, { title: "Capture your team's knowledge", text: "Use Add record or Quick capture to save procedures and repair notes. Search checks both titles and the information inside your records." }, { title: "Invite viewers and editors", text: "An administrator can create accounts in Settings & members. Viewers can read and download; editors can add, edit and delete records." }, { title: "Keep your server data safe", text: "Run one application instance with a persistent Docker volume. Use HTTPS for account credentials and back up the entire volume." }, { title: "Autodata remains separate", text: "The supplied binary files have not been imported. An optional VM gateway shortcut opens your existing setup, without converting or unlocking the original software." }].map(item => <div key={item.title}><h3 className="text-sm font-semibold">{item.title}</h3><p className="mt-1.5 text-xs leading-6 text-muted-foreground">{item.text}</p></div>)}</div></DialogContent></Dialog>
  </div>;
}
