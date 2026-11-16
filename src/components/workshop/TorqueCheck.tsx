import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/workshop-api";
import type { TorqueSpec, Vehicle } from "@/lib/workshop-types";
import { toast } from "sonner";

/*
 * Marking a torque checked is a judgement, so it asks what the judgement was
 * based on: an OEM sheet, a manual, a reference. The note is optional, but it is
 * the part that lets the next person find the same page.
 */
export default function TorqueCheck({ vehicle, spec, close, refresh }: {
  vehicle: Vehicle;
  spec: TorqueSpec;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [against, setAgainst] = useState(spec.checkedAgainst || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await api("torques", {
        vehicleId: vehicle.id,
        action: "check",
        fastener: spec.fastener,
        stage: spec.stage,
        against,
      });
      await refresh();
      toast.success("Marked as checked against an authorised source");
      close();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
    <DialogContent className="max-w-lg rounded-2xl border-border bg-white p-6 sm:rounded-2xl sm:p-8">
      <DialogHeader>
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><ShieldCheck size={22} /></span>
        <DialogTitle className="font-heading text-2xl font-bold">Check this torque</DialogTitle>
        <DialogDescription className="pt-1 leading-6">
          <span className="font-semibold text-foreground">{spec.fastener}</span>{spec.stage ? ` · stage ${spec.stage}` : ""} · {spec.value} {spec.unit}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={save} className="mt-2 space-y-3">
        <div>
          <label htmlFor="checked-against" className="mb-2 block text-xs font-semibold">Checked against</label>
          <Input
            id="checked-against"
            value={against}
            onChange={event => setAgainst(event.target.value)}
            maxLength={160}
            autoFocus
            placeholder="e.g. OEM workshop sheet, front suspension"
            className="h-11 rounded-lg border-border bg-white text-sm"
          />
          <p className="mt-2 text-[11px] leading-5 text-muted-foreground">Optional, but a name and a date without the sheet it came from is hard to stand behind later.</p>
        </div>
        {error && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="ghost" disabled={busy} onClick={close} className="h-10 rounded-lg text-xs">Cancel</Button>
          <Button disabled={busy} className="h-10 rounded-lg px-5 text-xs">{busy ? "Saving…" : "Mark checked"}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
