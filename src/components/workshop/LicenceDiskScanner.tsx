import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { BarcodeFormat } from "@zxing/library";
import { Camera, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { LicenceDiskDetails } from "@/lib/licence-disk";

/**
 * Camera capture for the PDF417 barcode on a vehicle licence disk. The stream is
 * stopped as soon as one barcode is read, so the reader's saved values are never
 * overwritten by a second pass.
 */
export default function LicenceDiskScanner({ close, onResult }: { close: () => void; onResult: (details: LicenceDiskDetails) => void }) {
  // A state ref rather than a plain ref: the effect needs to run once the video
  // element actually exists, which a plain ref cannot tell it.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const controls = useRef<IScannerControls | null>(null);
  const resultHandler = useRef(onResult);
  resultHandler.current = onResult;
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    if (!videoEl) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setStarting(false);
      setError("The camera only works on a secure address. Open Workshop Atlas over https:// or on the workshop PC at localhost, then scan again.");
      return;
    }
    // A machine with no camera, or a camera another program holds open, can wait
    // for permission forever; give up after a few seconds and say so.
    const startTimeout = setTimeout(() => {
      if (!active) return;
      active = false;
      controls.current?.stop();
      setStarting(false);
      setError("The camera did not start. Check that it is connected and allowed for this site, and that no other program is using it, then try again.");
    }, 12_000);
    const reader = new BrowserMultiFormatReader();
    reader.decodeFromVideoDevice(undefined, videoEl, (result, _decodeError, scanControls) => {
      if (!active || !result || result.getBarcodeFormat() !== BarcodeFormat.PDF_417) return;
      active = false;
      scanControls?.stop();
      resultHandler.current(result.getText());
    }).then(scanControls => {
      controls.current = scanControls;
      if (active) { clearTimeout(startTimeout); setStarting(false); }
      else scanControls.stop();
    }).catch((scanError: unknown) => {
      if (!active) return;
      clearTimeout(startTimeout);
      setStarting(false);
      const name = (scanError as { name?: string })?.name || "";
      setError(name === "NotAllowedError" || name === "SecurityError"
        ? "The browser blocked the camera. Allow camera access for this site, then scan again."
        : name === "NotFoundError" || name === "OverconstrainedError"
          ? "No camera was found on this computer."
          : "The camera could not be started. Close any other program using it, then try again.");
    });
    return () => {
      active = false;
      clearTimeout(startTimeout);
      controls.current?.stop();
    };
  }, [videoEl]);

  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="max-w-lg rounded-2xl border-border bg-white p-6 sm:rounded-2xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 font-heading text-xl font-bold"><Camera size={20} className="text-primary" />Scan licence disk</DialogTitle>
        <DialogDescription>Aim the camera at the PDF417 barcode printed on the vehicle's licence disk.</DialogDescription>
      </DialogHeader>
      <div className="relative mt-2 overflow-hidden rounded-xl bg-black">
        <video ref={setVideoEl} muted playsInline className="aspect-[4/3] w-full object-cover" />
        {!error && <div className="pointer-events-none absolute inset-6 rounded-lg border-2 border-dashed border-white/60" />}
        {starting && !error && <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs font-medium text-white"><Loader2 size={16} className="mr-2 animate-spin" />Starting the camera…</div>}
      </div>
      {error && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-xs leading-5 text-destructive">{error}</p>}
      <p className="text-[11px] leading-5 text-muted-foreground">Hold the disk steady in good light. Only the barcode is read, and the details it holds are shown for you to check before saving.</p>
      <div className="flex justify-end"><Button type="button" variant="outline" onClick={close} className="h-10 rounded-lg px-5">Cancel</Button></div>
    </DialogContent>
  </Dialog>;
}
