import { useState } from "react";
import { Database, Download, ExternalLink, KeyRound, Loader2, Pencil, Plus, ShieldCheck, Trash2, Users, Server, LockKeyhole, FileText, Upload, Eye, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { RepairSheetOperation, RepairTimePdf, User, Workspace } from "@/lib/workshop-types";
import { api, download, fileUrl, uploadFile } from "@/lib/workshop-api";
import { Panel, PanelHeading, Pick, fileSize, prettyDate } from "./primitives";
import { toast } from "sonner";

export default function Settings({ data, refresh, onAuth, confirmDelete }: { data: Workspace; refresh: () => Promise<void>; onAuth: () => void; confirmDelete: (entity: string, id: string, title: string) => void }) {
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFormat, setImportFormat] = useState("csv");
  const [member, setMember] = useState<{ user?: User; reset?: boolean } | null>(null);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfVehicle, setPdfVehicle] = useState("none");
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const [preview, setPreview] = useState<{ id: string; name: string; url: string } | null>(null);
  const [reader, setReader] = useState<{ id: string; name: string; vehicleId: string | null; pages: number; operations: RepairSheetOperation[] } | null>(null);
  const [readBusy, setReadBusy] = useState(false);
  const [readError, setReadError] = useState("");
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyVehicle, setApplyVehicle] = useState("none");

  const formatMinutes = (minutes: number) => minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h ${minutes % 60} min`;
  const operationLabel = (op: RepairSheetOperation) => op.operation.startsWith(op.code) ? op.operation.slice(op.code.length).trim() : op.operation;
  const editor = Boolean(data.user && data.user.role !== "viewer");
  const admin = Boolean(data.user && data.user.role === "admin");
  const sheets = data.repairTimePdfs || [];
  const vehicleLabel = (vehicleId: string | null) => {
    const vehicle = vehicleId ? data.vehicles.find(item => item.id === vehicleId) : undefined;
    return vehicle ? `${vehicle.make} ${vehicle.model}`.trim() : "Whole workshop";
  };

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true);
    try { await api("settings", Object.fromEntries(new FormData(event.currentTarget))); await refresh(); toast.success("Workspace settings saved"); }
    catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }

  async function importTimes(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setImporting(true);
    try { const result = await api<{ entries: number; vins: number; vehicles: number }>("repair-times", { action: "import", format: importFormat, data: String(new FormData(event.currentTarget).get("data") || "") }); await refresh(); toast.success(`Imported ${result.entries} entries for ${result.vins} VIN${result.vins === 1 ? "" : "s"} · ${result.vehicles} vehicle${result.vehicles === 1 ? "" : "s"} updated`); }
    catch (e) { toast.error((e as Error).message); } finally { setImporting(false); }
  }

  async function uploadPdf(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();      if (!pdfFile) { setPdfError("Choose a PDF repair-time sheet first."); return; }
    setPdfBusy(true); setPdfError("");
    try {
      const form = new FormData();
      form.append("file", pdfFile);
      if (pdfVehicle && pdfVehicle !== "none") form.append("vehicleId", pdfVehicle);
      await uploadFile("repair-times", form);
      await refresh();
      toast.success(`Uploaded ${pdfFile.name}`);
      setPdfOpen(false); setPdfFile(null); setPdfVehicle("none");
    } catch (e) { setPdfError((e as Error).message); }
    finally { setPdfBusy(false); }
  }

  async function viewPdf(sheet: RepairTimePdf) {
    setPdfError("");
    try { setPreview({ id: sheet.id, name: sheet.name, url: await fileUrl(`repair-times-pdfs/${sheet.id}`) }); }
    catch (e) { setPdfError((e as Error).message); }
  }

  async function readSheet(sheet: RepairTimePdf) {
    setReadError(""); setPdfError(""); setReadBusy(true);
    try {
      const result = await api<{ sheet: { id: string; name: string; vehicleId: string | null }; pages: number; operations: RepairSheetOperation[] }>("repair-times", { action: "extract", id: sheet.id });
      setReader({ id: result.sheet.id, name: result.sheet.name, vehicleId: result.sheet.vehicleId, pages: result.pages, operations: result.operations });
      setApplyVehicle(result.sheet.vehicleId || data.vehicles[0]?.id || "none");
    } catch (e) {
      const message = (e as Error).message;
      // A scan or photo has no text layer, so the panel has to say so; the reader never opens.
      setReadError(message); setPdfError(message); toast.error(message);
    }
    finally { setReadBusy(false); }
  }

  async function applySheet() {
    if (!reader || applyVehicle === "none") return;
    setReadError(""); setApplyBusy(true);
    try {
      const result = await api<{ applied: number; vehicleId: string; skipped: number }>("repair-times", { action: "apply", id: reader.id, vehicleId: applyVehicle });
      await refresh();
      toast.success(`Applied ${result.applied} repair-time operations to ${vehicleLabel(result.vehicleId)}`);
      setReader(null);
    } catch (e) { setReadError((e as Error).message); }
    finally { setApplyBusy(false); }
  }

  function closeReader() { setReader(null); setReadError(""); setApplyBusy(false); }
  function closePreview() { if (preview) URL.revokeObjectURL(preview.url); setPreview(null); }

  async function removePdf(sheet: RepairTimePdf) {
    if (!window.confirm(`Delete the repair-time sheet “${sheet.name}”?`)) return;
    setPdfBusy(true); setPdfError("");
    try { await api("repair-times", { action: "delete", id: sheet.id }); await refresh(); toast.success(`Deleted ${sheet.name}`); }
    catch (e) { setPdfError((e as Error).message); }
    finally { setPdfBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div className="grid items-start gap-6 xl:grid-cols-[1.5fr_1fr]">
        <Panel>
          <PanelHeading title="Workshop details" subtitle="Your workspace identity and optional legacy VM shortcut" />
          <form onSubmit={save} className="space-y-5 p-6" key={`${data.name}-${data.vmUrl}`}>
            <div><Label htmlFor="workshop-name" className="text-xs font-semibold">Workshop name</Label><Input id="workshop-name" name="name" required disabled={!editor} defaultValue={data.name} maxLength={100} className="mt-2 h-11 rounded-lg" /></div>
            <div><Label htmlFor="vm-url" className="text-xs font-semibold">Browser-accessible VM URL <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="vm-url" name="vmUrl" type="url" disabled={!editor} defaultValue={data.vmUrl} placeholder="http://your-vm-gateway:port" maxLength={1000} className="mt-2 h-11 rounded-lg" /><p className="mt-2 text-[11px] leading-5 text-muted-foreground">A shortcut to an existing browser gateway, such as Guacamole or noVNC. This does not set up remote access or import Autodata.</p></div>
            <div className="flex items-center gap-2">{editor
              ? <Button disabled={saving} className="h-10 rounded-lg px-5 text-xs font-semibold">{saving && <Loader2 size={14} className="mr-2 animate-spin" />}Save changes</Button>
              : <p className="flex items-center gap-2 text-xs text-muted-foreground"><LockKeyhole size={14} />Only administrators can change workspace settings.</p>
            }</div>
          </form>
        </Panel>

        <Panel>
          <PanelHeading title="Storage & ownership" subtitle="A workspace that stays on your server" />
          <div className="space-y-5 p-6">
            <div className="flex items-start gap-3"><span className="rounded-lg bg-primary/10 p-2 text-primary"><Server size={18} /></span><div><h3 className="text-xs font-semibold">Local server storage</h3><p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">Workshop records, accounts and files are stored server-side, not in browser storage. Use a persistent Docker volume for deployment.</p></div></div>
            <div className="flex items-start gap-3"><span className="rounded-lg bg-primary/10 p-2 text-primary"><ShieldCheck size={18} /></span><div><h3 className="text-xs font-semibold">Access checked on every request</h3><p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">Viewers read and download. Editors maintain records. Administrators also manage accounts and settings.</p></div></div>
            <div className="border-t border-border pt-4"><Button disabled={!editor} variant="outline" onClick={() => download("export", "workshop-atlas-records.json").catch(e => toast.error(e.message))} className="h-10 w-full rounded-lg text-xs"><Download size={15} className="mr-2" />Export workshop records</Button><p className="mt-2 text-[10px] leading-5 text-muted-foreground">JSON record export excludes account credentials and file contents. Back up the entire data volume for a complete restore.</p></div>
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeading title="Repair time data" subtitle="Import licensed repair times keyed by VIN" />
        <div className="p-6">
          {admin ? (
            <form onSubmit={importTimes} className="space-y-4">
              <div><Label className="mb-2 block text-xs">Import format</Label><Pick label="Import format" value={importFormat} onChange={setImportFormat} options={[{ value: "csv", label: "CSV · vin, operation, minutes" }, { value: "json", label: "JSON · [{ vin, operation, minutes }]" }]} /></div>
              <div><Label htmlFor="repair-times-data" className="text-xs font-semibold">Repair-time data</Label><Textarea id="repair-times-data" name="data" required maxLength={2000000} placeholder={importFormat === "csv" ? "vin,operation,minutes\nWV2ZZZ2KZKX135899,Brake pads front,90" : "[{\n  \"vin\": \"WV2ZZZ2KZKX135899\",\n  \"operation\": \"Brake pads front\",\n  \"minutes\": 90\n}]"} className="mt-2 min-h-32 rounded-xl border-border bg-white font-mono text-xs leading-6" /></div>
              <p className="text-[11px] leading-5 text-muted-foreground">Matching vehicles receive these times immediately; each vehicle page also has a Refresh action. Provider lookups only run when <code className="rounded bg-background px-1">REPAIR_API_URL</code> is configured on the server. Only import data your licence allows you to reuse.</p>
              <Button disabled={importing} className="h-10 rounded-lg px-5 text-xs font-semibold">{importing && <Loader2 size={14} className="mr-2 animate-spin" />}Import repair times</Button>
            </form>
          ) : (
            <p className="text-xs text-muted-foreground">Only administrators can import repair-time data.</p>
          )}
        </div>
      </Panel>

      <Panel>
        <PanelHeading title="Repair time PDFs" subtitle="Printed repair-time sheets kept with the vehicles they belong to" action={admin ? <Button onClick={() => { setPdfError(""); setPdfFile(null); setPdfVehicle("none"); setPdfOpen(true); }} className="h-9 rounded-lg text-xs"><Upload size={14} className="mr-1.5" />Add PDF</Button> : undefined} />
        <div className="p-6">
          {!admin ? (
            <p className="text-xs text-muted-foreground">Only administrators can manage repair-time PDFs.</p>
          ) : sheets.length === 0 ? (
            <p className="text-xs text-muted-foreground">No repair-time sheets yet. Add a PDF to keep it alongside its vehicle.</p>
          ) : (
            <div className="divide-y divide-border">
              {sheets.map(sheet => (
                <div key={sheet.id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><FileText size={18} /></span>
                  <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{sheet.name}</p><p className="text-[11px] text-muted-foreground">{fileSize(sheet.size)} · {prettyDate(sheet.createdAt)} · {sheet.createdBy}</p></div>
                  <Badge variant="secondary" className="rounded-md bg-background px-2.5 py-1 text-[10px]">{vehicleLabel(sheet.vehicleId)}</Badge>
                  <Button variant="ghost" onClick={() => viewPdf(sheet)} className="h-8 rounded-lg px-2 text-xs font-semibold text-primary"><Eye size={13} className="mr-1.5" />View</Button>
                  <Button variant="ghost" onClick={() => readSheet(sheet)} disabled={readBusy || applyBusy} className="h-8 rounded-lg px-2 text-xs font-semibold text-primary"><ListChecks size={13} className="mr-1.5" />Read times</Button>
                  <Button variant="ghost" size="icon" aria-label={`Delete ${sheet.name}`} className="h-8 w-8 rounded-lg text-destructive" onClick={() => removePdf(sheet)} disabled={pdfBusy || applyBusy}><Trash2 size={14} /></Button>
                </div>
              ))}
            </div>
          )}
          {pdfError && <p role="alert" className="mt-3 text-xs text-destructive">{pdfError}</p>}
        </div>
      </Panel>

      <Panel>
        <PanelHeading title="Team & permissions" subtitle="Give each terminal's user the right level of access" action={editor ? <Button onClick={() => setMember({})} className="h-9 rounded-lg text-xs"><Plus size={14} className="mr-1.5" />Add member</Button> : undefined} />
        {editor ? (
          <div className="divide-y divide-border">
            {data.users.map(user => (
              <div key={user.id} className="flex flex-wrap items-center gap-3 p-5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">{user.name.split(" ").map(s => s[0]).slice(0, 2).join("")}</span>
                <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{user.name}{user.id === data.user.id && <span className="ml-2 text-[10px] font-normal text-muted-foreground">(you)</span>}</p><p className="mt-1 truncate text-xs text-muted-foreground">{user.email}</p></div>
                <Badge variant="secondary" className="rounded-md bg-background px-2.5 py-1 text-[10px] capitalize">{user.role}</Badge>
                <Button variant="ghost" size="icon" aria-label={`Edit ${user.name}`} onClick={() => setMember({ user })} className="h-8 w-8 rounded-lg text-muted-foreground"><Pencil size={14} /></Button>
                <Button variant="ghost" size="icon" aria-label={`Reset password for ${user.name}`} onClick={() => setMember({ user, reset: true })} className="h-8 w-8 rounded-lg text-muted-foreground"><KeyRound size={14} /></Button>
                {user.id !== data.user.id && <Button variant="ghost" size="icon" aria-label={`Remove ${user.name}`} onClick={() => confirmDelete("user", user.id, user.name)} className="h-8 w-8 rounded-lg text-destructive"><Trash2 size={14} /></Button>}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-4 p-6">
            <Users size={24} className="shrink-0 text-primary" />
            <div><p className="text-sm font-semibold">Accounts are managed by your workshop administrator.</p><p className="mt-2 text-xs leading-6 text-muted-foreground">{data.user ? `Your current access is ${data.user.role}. Ask your administrator to change your role or reset your password.` : "Create the initial administrator account or sign in to your existing workshop."}</p>
              {!data.user && <Button onClick={onAuth} variant="outline" className="mt-3 h-9 rounded-lg text-xs">{data.setupRequired ? "Set up workshop" : "Sign in"}</Button>}
            </div>
          </div>
        )}
      </Panel>

      {member && <MemberDialog member={member} close={() => setMember(null)} refresh={refresh} />}

      {pdfOpen && (
        <Dialog open onOpenChange={open => { if (!open && !pdfBusy) setPdfOpen(false); }}>
          <DialogContent className="max-w-lg rounded-2xl border-border bg-white p-7 sm:rounded-2xl">
            <DialogHeader><DialogTitle className="font-heading text-2xl font-bold">Add a repair-time sheet.</DialogTitle><DialogDescription className="pt-2 leading-6">Upload the printed PDF once. Read its times from the sheet list and apply them to the vehicle you choose.</DialogDescription></DialogHeader>
            <form onSubmit={uploadPdf} className="mt-2 space-y-4">
              <div><Label className="mb-2 block text-xs font-semibold">Vehicle this sheet belongs to</Label><Pick value={pdfVehicle || "none"} onChange={setPdfVehicle} label="Vehicle" options={[{ value: "none", label: "Not attached — choose when applying" }, ...data.vehicles.map(v => ({ value: v.id, label: `${v.make} ${v.model} ${v.year}`.trim() }))]} /></div>
              <div><Label htmlFor="repair-sheet-file" className="text-xs font-semibold">PDF sheet</Label><Input id="repair-sheet-file" type="file" accept="application/pdf,.pdf" onChange={event => setPdfFile(event.target.files?.[0] || null)} className="mt-2 h-11 rounded-lg" /><p className="mt-2 text-[11px] leading-5 text-muted-foreground">{pdfFile ? `${pdfFile.name} · ${fileSize(pdfFile.size)}` : "A PDF with a text layer, up to 10 MB. Scans and photos without text cannot be read."}</p></div>
              {pdfError && <p role="alert" className="text-sm text-destructive">{pdfError}</p>}
              <div className="flex justify-end gap-2"><Button variant="outline" type="button" disabled={pdfBusy} onClick={() => setPdfOpen(false)} className="h-11 rounded-lg">Cancel</Button><Button disabled={pdfBusy || !pdfFile} className="h-11 rounded-lg">{pdfBusy && <Loader2 size={16} className="mr-2 animate-spin" />}Upload sheet</Button></div>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {preview && (
        <Dialog open onOpenChange={open => { if (!open) closePreview(); }}>
          <DialogContent className="max-w-4xl rounded-2xl border-border bg-white p-5 sm:rounded-2xl">      <DialogHeader><DialogTitle className="font-heading text-xl font-bold">{preview.name}</DialogTitle><DialogDescription>Repair-time sheet stored on your workshop server.</DialogDescription></DialogHeader>
            <iframe src={preview.url} title={preview.name} className="h-[56vh] w-full rounded-xl border border-border bg-background" />
            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => download(`repair-times-pdfs/${preview.id}`, preview.name).catch(e => setPdfError(e.message))} className="h-9 rounded-lg text-xs"><Download size={14} className="mr-1.5" />Download</Button>
              <Button onClick={closePreview} className="h-9 rounded-lg text-xs">Close</Button>
            </div
>
          </DialogContent>
        </Dialog>
      )}

      {reader && (
        <Dialog open onOpenChange={open => { if (!open && !readBusy && !applyBusy) closeReader(); }}>
          <DialogContent className="max-w-3xl rounded-2xl border-border bg-white p-5 sm:rounded-2xl">
            <DialogHeader><DialogTitle className="font-heading text-xl font-bold">{reader.name}</DialogTitle><DialogDescription>{reader.operations.length} repair-time operations · {reader.pages} page{reader.pages === 1 ? "" : "s"} · {reader.operations.reduce((sum, op) => sum + op.minutes, 0)} min total</DialogDescription></DialogHeader>

            <div className="p-5 border-t border-border">
              <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
                {reader.operations.slice(0, 120).map(op => (
                  <div key={op.code + "-" + op.minutes} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs">
                    <span className="font-medium">{op.code}</span>
                    <span className="truncate flex-1 text-muted-foreground">{operationLabel(op)}</span>
                    <span className="shrink-0 font-medium text-primary">{formatMinutes(op.minutes)}</span>
                  </div>
                ))}
                {reader.operations.length > 120 && <p className="py-2 text-[11px] text-muted-foreground">Showing the first 120 of {reader.operations.length} operations.</p>}
              </div>
              <div className="mt-4 space-y-2">
                <Label className="text-xs font-semibold">Apply to vehicle</Label>
                <Pick value={applyVehicle} onChange={setApplyVehicle} label="Apply to vehicle" options={[{ value: "none", label: "Choose a vehicle" }, ...data.vehicles.map(v => ({ value: v.id, label: `${v.make} ${v.model} ${v.year}`.trim() }))]} />
                <p className="text-[11px] leading-5 text-muted-foreground">Operations with the same code on the target vehicle are replaced. Vehicles with a VIN also keep the times for future lookups.</p>
                {readError && <p role="alert" className="text-xs text-destructive">{readError}</p>}
                <div className="flex gap-3 pt-1">
                  <Button disabled={applyBusy || readBusy || applyVehicle === "none"} className="h-10 flex-1 rounded-lg" onClick={applySheet}>{applyBusy && <Loader2 size={14} className="mr-2 animate-spin" />}Apply {reader.operations.length} operations</Button>
                  <Button variant="outline" disabled={readBusy || applyBusy} onClick={closeReader} className="h-10 rounded-lg">Close</Button>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

    </div>
  );
}

function MemberDialog({ member, close, refresh }: { member: { user?: User; reset?: boolean }; close: () => void; refresh: () => Promise<void> }) {
  const [role, setRole] = useState(member.user?.role || "viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { await api("users", { ...Object.fromEntries(new FormData(event.currentTarget)), role, id: member.user?.id, action: member.reset ? "password" : "save" }); await refresh(); close(); toast.success(member.reset ? "Password reset. Existing sessions have been revoked" : "Member saved"); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
      <DialogContent className="max-w-md rounded-2xl border-border bg-white p-7 sm:rounded-2xl">
        <DialogHeader><DialogTitle className="font-heading text-2xl font-bold">{member.reset ? "Reset member password" : member.user ? "Edit team member" : "Invite the team in."}</DialogTitle><DialogDescription className="pt-2 leading-6">{member.reset ? `Set a new password for ${member.user.name}. Their current sessions will be revoked.` : "Create or update a local account. Share initial credentials securely with the member."}</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="mt-2 space-y-4" encType="multipart/form-data">
          {!member.reset && <>
            <div><Label htmlFor="member-name" className="text-xs">Name</Label><Input id="member-name" name="name" required defaultValue={member.user?.name} maxLength={100} className="mt-2 h-11 rounded-lg" /></div>
            <div><Label htmlFor="member-email" className="text-xs">Email</Label><Input id="member-email" name="email" type="email" required defaultValue={member.user?.email} maxLength={200} className="mt-2 h-11 rounded-lg" /></div>
            <div><Label className="mb-2 block text-xs">Access level</Label><Pick value={role} onChange={value => setRole(value as typeof role)} label="Access level" options={[{ value: "viewer", label: "Viewer · Read and download" }, { value: "editor", label: "Editor · Add and edit records" }, { value: "admin", label: "Administrator · Manage everything" }]} /></div>
          </>}
          {(!member.user || member.reset) && <div><Label htmlFor="member-password" className="text-xs">{member.reset ? "New" : "Initial"} password</Label><Input id="member-password" name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} placeholder="At least 12 characters" className="mt-2 h-11 rounded-lg" /></div>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button disabled={busy} className="h-11 w-full rounded-lg">{busy && <Loader2 size={15} className="mr-2 animate-spin" />}{member.reset ? "Reset password" : "Save member"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function formatMinutes(minutes: number) { return minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h ${minutes % 60} min`; }
