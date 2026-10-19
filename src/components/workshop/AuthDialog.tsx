import { useState } from "react";
import { Loader2, ShieldCheck, LogOut } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, setSession } from "@/lib/workshop-api";
import type { Workspace } from "@/lib/workshop-types";
import { toast } from "sonner";
export default function AuthDialog({ open, onOpenChange, data, refresh }: { open: boolean; onOpenChange: (open: boolean) => void; data: Workspace; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setup = data.setupRequired;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await api<{ token: string }>("auth", { ...form, action: setup ? "setup" : "login" });
      setSession(result.token); await refresh(); onOpenChange(false);
      toast.success(setup ? "Your workshop is ready" : "Welcome back to your workshop");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true);
    try { await api("auth", { action: "logout" }); setSession(); await refresh(); onOpenChange(false); toast.success("Signed out"); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={value => { setError(""); onOpenChange(value); }}><DialogContent className="max-h-[90vh] max-w-[440px] overflow-y-auto rounded-2xl border-border bg-white p-7 sm:rounded-2xl"><DialogHeader><img src="/assets/atlas-mark.png" alt="" className="mb-4 h-12 w-12 rounded-xl" /><DialogTitle className="font-heading text-2xl font-bold tracking-tight">{data.user ? "Your workshop account" : setup ? "Make this workshop yours." : "Welcome back."}</DialogTitle><DialogDescription className="pt-2 leading-6">{data.user ? `Signed in as ${data.user.email}. Your access level is ${data.user.role}.` : setup ? "Create the first administrator account. Then invite your team as editors or viewers." : "Sign in to access your team's vehicles and workshop knowledge."}</DialogDescription></DialogHeader>
    {data.user ? <Button disabled={busy} onClick={logout} variant="outline" className="mt-3 h-11 rounded-lg"><LogOut size={16} className="mr-2" />Sign out</Button> : <form onSubmit={submit} className="mt-2 space-y-4">
      {setup && <><Field label="Workshop name" name="workshopName" autoComplete="organization" placeholder="e.g. Northside Automotive" maxLength={100} /><Field label="Your name" name="name" autoComplete="name" placeholder="Full name" maxLength={100} /></>}
      <Field label="Email address" name="email" type="email" autoComplete="username" placeholder="you@workshop.com" maxLength={200} />
      <Field label="Password" name="password" type="password" autoComplete={setup ? "new-password" : "current-password"} placeholder={setup ? "At least 12 characters" : "Your password"} minLength={setup ? 12 : 1} maxLength={128} />
      {setup && <div><Label htmlFor="setupKey" className="text-xs">Setup key <span className="font-normal text-muted-foreground">(if configured on your server)</span></Label><Input id="setupKey" name="setupKey" type="password" className="mt-2 h-11 rounded-lg" /></div>}
      {error && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      <Button disabled={busy} className="h-11 w-full rounded-lg font-semibold">{busy && <Loader2 size={16} className="mr-2 animate-spin" />}{setup ? "Create workshop" : "Sign in"}</Button>
      <p className="flex items-center justify-center gap-2 pt-1 text-[11px] text-muted-foreground"><ShieldCheck size={14} />Credentials stay on your workshop server</p>
    </form>}{data.user && error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </DialogContent></Dialog>;
}
function Field({ label, ...props }: React.ComponentProps<typeof Input> & { label: string }) {
  return <div><Label htmlFor={props.name} className="text-xs font-semibold">{label}</Label><Input {...props} id={props.name} required className="mt-2 h-11 rounded-lg border-border bg-white" /></div>;
}
