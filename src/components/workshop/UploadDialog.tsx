import { useState } from "react";
import { UploadCloud, File, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/workshop-api";
import type { Workspace } from "@/lib/workshop-types";
import { Pick, fileSize } from "./primitives";
import { toast } from "sonner";
export default function UploadDialog({ data, recordId, close, refresh }: { data: Workspace; recordId?: string; close: () => void; refresh: () => Promise<void> }) {
  const [linked, setLinked] = useState(recordId || "none");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function upload(event: React.FormEvent) {
    event.preventDefault(); if (!file) return; setBusy(true); setError("");
    if (file.size > 10 * 1024 * 1024) { setError("Choose a file smaller than 10 MB"); setBusy(false); return; }
    const form = new FormData(); form.set("file", file); form.set("recordId", linked);
    try { await request("attachments", { method: "POST", body: form }); await refresh(); close(); toast.success("Attachment added to your workshop"); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="max-w-lg rounded-2xl border-border bg-white p-7 sm:rounded-2xl"><DialogHeader><DialogTitle className="font-heading text-2xl font-bold">Keep the details together.</DialogTitle><DialogDescription className="pt-2 leading-6">Attach a document or photo to a vehicle or workshop record.</DialogDescription></DialogHeader><form onSubmit={upload} className="mt-2 space-y-5"><div><label className="mb-2 block text-xs font-semibold">Linked vehicle or record</label><Pick value={linked} onChange={setLinked} label="Linked record" options={[{ value: "none", label: "Select a vehicle or record" }, ...data.vehicles.map(v => ({ value: v.id, label: `${v.make} ${v.model} ${v.year}` })), ...data.records.map(r => ({ value: r.id, label: r.title }))]} /></div><label onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); setFile(event.dataTransfer.files[0] || null); }} className="relative flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed border-primary/20 bg-primary/[0.025] px-5 py-8 text-center hover:bg-primary/5"><input aria-label="Choose attachment" type="file" accept="image/jpeg,image/png,image/webp,application/pdf,text/plain" className="absolute inset-0 cursor-pointer opacity-0" onChange={event => setFile(event.target.files?.[0] || null)} />{file ? <File className="mb-3 text-primary" size={28} /> : <UploadCloud className="mb-3 text-primary" size={32} />}<span className="max-w-full break-all text-sm font-semibold">{file?.name || "Click to upload or drop a file"}</span><span className="mt-2 text-xs text-muted-foreground">{file ? fileSize(file.size) : "JPG, PNG, WebP, PDF or TXT · up to 10 MB"}</span></label>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<div className="flex justify-end gap-2"><Button variant="outline" type="button" disabled={busy} onClick={close} className="h-11 rounded-lg">Cancel</Button><Button disabled={busy || !file || linked === "none"} className="h-11 rounded-lg">{busy && <Loader2 size={16} className="mr-2 animate-spin" />}Upload attachment</Button></div></form></DialogContent></Dialog>;
}
