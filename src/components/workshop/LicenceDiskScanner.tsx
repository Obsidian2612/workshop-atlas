import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat } from "@zxing/library";
import { Camera, ImageUp, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { parseLicenceDisk, licenceDiskHasDetails, type LicenceDiskDetails } from "@/lib/licence-disk";

type CropRect = { left: number; top: number; width: number; height: number };
type Corner = "nw" | "ne" | "sw" | "se" | "move";

const DEFAULT_CROP: CropRect = { left: 0.15, top: 0.18, width: 0.7, height: 0.64 };

// A photo of a licence disk is never crisp enough for one fixed sample, so the
// decoder tries a few render scales and a couple of binarisation thresholds
// before it gives up. The first sample that yields a barcode wins.
const CROP_SCALES = [1, 1.5, 2, 3];
const WHOLE_SCALES = [1, 1.5, 2];
const BINARIZE_THRESHOLDS: Array<number | null> = [null, 120, 160];
const MAX_CANVAS_EDGE = 2400;

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }

function applyDrag(prev: CropRect, corner: Corner, dx: number, dy: number, boxW: number, boxH: number): CropRect {
  const ux = 1 / Math.max(1, boxW);
  const uy = 1 / Math.max(1, boxH);
  let l = prev.left, t = prev.top, r = l + prev.width, b = t + prev.height;
  if (corner === "move") { l += dx * ux; t += dy * uy; }
  else {
    if (corner.includes("w")) { l += dx * ux; if (l > r - 0.04) l = r - 0.04; }
    if (corner.includes("e")) { r += dx * ux; if (r < l + 0.04) r = l + 0.04; }
    if (corner.includes("n")) { t += dy * uy; if (t > b - 0.04) t = b - 0.04; }
    if (corner.includes("s")) { b += dy * uy; if (b < t + 0.04) b = t + 0.04; }
  }
  return { left: clamp01(l), top: clamp01(t), width: clamp01(r - l), height: clamp01(b - t) };
}

function makeCanvas(
  img: HTMLImageElement,
  sx: number, sy: number, sw: number, sh: number,
  requestedScale: number,
  threshold: number | null,
): HTMLCanvasElement | null {
  const largestEdge = Math.max(sw, sh) || 1;
  const scale = Math.min(Math.max(0.05, requestedScale), MAX_CANVAS_EDGE / largestEdge);
  const width = Math.max(4, Math.round(sw * scale));
  const height = Math.max(4, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // Some exports (and screenshots) put the bars on a transparent background:
  // their RGB is black everywhere, which would binarise to a solid-black crop.
  // Lay the photo onto white first so the bars keep their contrast.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, width, height);
  if (threshold !== null) {
    try {
      const frame = ctx.getImageData(0, 0, width, height);
      const px = frame.data;
      for (let i = 0; i < px.length; i += 4) {
        const grey = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
        const value = grey < threshold ? 0 : 255;
        px[i] = value;
        px[i + 1] = value;
        px[i + 2] = value;
        px[i + 3] = 255;
      }
      ctx.putImageData(frame, 0, 0);
    } catch {
      // A canvas we cannot read back keeps the plain render, which is still worth decoding.
    }
  }
  return canvas;
}

// decodeFromCanvas *rejects* with NotFoundException when a sample holds no
// barcode, so each attempt has to be caught: a miss is just the next sample.
async function decodeCanvas(canvas: HTMLCanvasElement): Promise<string | null> {
  try {
    const result = await new BrowserMultiFormatReader().decodeFromCanvas(canvas);
    return result ? result.getText() : null;
  } catch {
    return null;
  }
}

async function decodeRegion(
  img: HTMLImageElement,
  sx: number, sy: number, sw: number, sh: number,
  scales: number[],
): Promise<string | null> {
  for (const scale of scales) {
    for (const threshold of BINARIZE_THRESHOLDS) {
      const canvas = makeCanvas(img, sx, sy, sw, sh, scale, threshold);
      if (!canvas) continue;
      const text = await decodeCanvas(canvas);
      if (text) return text;
    }
  }
  return null;
}

export default function LicenceDiskScanner({ close, onResult }: { close: () => void; onResult: (details: LicenceDiskDetails) => void }) {
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const controls = useRef<{ stop: () => void } | null>(null);
  const resultHandler = useRef(onResult);
  resultHandler.current = onResult;
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState("");
  const [photoCropOpen, setPhotoCropOpen] = useState(false);

  useEffect(() => {
    let active = true;
    if (!videoEl) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setStarting(false);
      setError("The camera needs a secure website address. On the shop PC open Workshop Atlas at https://… or at localhost, or read a photo of the disk instead. On an iPhone over plain http, use the photo option below.");
      return;
    }
    const startTimeout = setTimeout(() => {
      if (!active) return;
      active = false;
      controls.current?.stop();
      setStarting(false);
      setError("The camera did not start. Check that it is connected, allowed for this site and not in use by another program, then try again.");
    }, 12_000);
    const reader = new BrowserMultiFormatReader();
    reader.decodeFromVideoDevice(undefined, videoEl, (result, _decodeError, scanControls) => {
      if (!active || !result || result.getBarcodeFormat() !== BarcodeFormat.PDF_417) return;
      const details = parseLicenceDisk(result.getText());
      if (!licenceDiskHasDetails(details)) return;
      active = false;
      scanControls?.stop();
      resultHandler.current(details);
    }).then(scanControls => {
      controls.current = scanControls;
      if (active) { clearTimeout(startTimeout); setStarting(false); }
      else scanControls?.stop();
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
    return () => { active = false; clearTimeout(startTimeout); controls.current?.stop(); };
  }, [videoEl]);

  function handleCropResult({ text }: { text: string }) {
    const details = parseLicenceDisk(text);
    if (!licenceDiskHasDetails(details)) {
      setError("That barcode was read, but it doesn't hold licence disk details. Photograph the PDF417 barcode printed on the disk itself.");
      setPhotoCropOpen(true);
      return;
    }
    setPhotoCropOpen(false);
    onResult(details);
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) close(); }}>
      <DialogContent className="max-w-lg rounded-2xl border-border bg-white p-6 sm:rounded-2xl" onClose={close}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-heading text-xl font-bold"><Camera size={20} className="text-primary" />Scan licence disk</DialogTitle>
          <DialogDescription>Aim the camera at the PDF417 barcode printed on the vehicle's licence disk, or read a photo of it.</DialogDescription>
        </DialogHeader>
        {!photoCropOpen && (
          <div className="relative mt-2 overflow-hidden rounded-xl bg-black">
            <video ref={setVideoEl} muted playsInline className="aspect-[4/3] w-full object-cover" />
            {!error && <div className="pointer-events-none absolute inset-6 rounded-lg border-2 border-dashed border-white/60" />}
            {starting && !error && <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs font-medium text-white"><Loader2 size={16} className="mr-2 animate-spin" />Starting the camera…</div>}
            {error && <div className="absolute inset-0 flex items-center justify-center bg-black/40 p-3"><p className="text-xs text-white/90 leading-5">{error}</p></div>}
          </div>
        )}
        {error && !photoCropOpen && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-xs leading-5 text-destructive">{error}</p>}
        {!error && !photoCropOpen && <p className="text-xs leading-5 text-muted-foreground">Hold the disk steady in good light. Only the barcode is read, and the details it holds are shown for you to check before saving. On a plain http address the camera is blocked — choose a photo instead.</p>}
        <CropModal onCropRead={handleCropResult} onCloseCrop={() => setPhotoCropOpen(false)} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="outline" onClick={close} className="h-10 rounded-lg px-5">Cancel</Button>
          {!photoCropOpen && window.isSecureContext && navigator.mediaDevices?.getUserMedia && starting && <span className="text-[11px] text-muted-foreground">Opening camera…</span>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CropModal({ onCropRead, onCloseCrop }: { onCropRead: (result: { text: string }) => void; onCloseCrop: () => void }) {
  const [image, setImage] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [crop, setCrop] = useState<CropRect>(DEFAULT_CROP);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ corner: Corner; startX: number; startY: number; orig: CropRect } | null>(null);

  const previewUrl = useMemo(() => (image ? URL.createObjectURL(image) : ""), [image]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = drag.current;
      if (!d || !boxRef.current) return;
      setCrop(prev => applyDrag(prev, d.corner, e.clientX - d.startX, e.clientY - d.startY, boxRef.current!.clientWidth, boxRef.current!.clientHeight));
    }
    function onUp() { drag.current = null; }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, []);

  async function loadImage(file: File) {
    setLoading(true); setError("");
    const url = URL.createObjectURL(file);
    const img = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("That file could not be opened as an image."));
        img.src = url;
      });
      imgRef.current = img;
      setDims({ w: img.naturalWidth, h: img.naturalHeight });
      setImage(file);
      setCrop(DEFAULT_CROP);
    } catch (loadError) {
      setError((loadError as Error).message || "That file could not be opened as an image.");
    } finally {
      URL.revokeObjectURL(url);
      setLoading(false);
    }
  }

  async function readCrop() {
    const box = boxRef.current;
    const imgEl = imgRef.current;
    if (!box || !imgEl || !dims) return;
    const boxW = box.clientWidth, boxH = box.clientHeight;
    // The preview letterboxes the photo (object-contain), so map the crop from
    // preview space back into source pixels through that same fit scale.
    const fit = Math.min(boxW / dims.w, boxH / dims.h);
    const offsetX = (boxW - fit * dims.w) / 2;
    const offsetY = (boxH - fit * dims.h) / 2;
    let sx = (crop.left * boxW - offsetX) / fit;
    let sy = (crop.top * boxH - offsetY) / fit;
    let sw = (crop.width * boxW) / fit;
    let sh = (crop.height * boxH) / fit;
    sx = Math.max(0, Math.min(dims.w - 1, sx));
    sy = Math.max(0, Math.min(dims.h - 1, sy));
    sw = Math.min(dims.w - sx, sw);
    sh = Math.min(dims.h - sy, sh);
    if (sw < 8 || sh < 8) { setError("That crop is too small. Drag it around the square barcode."); return; }
    setLoading(true); setError("");
    try {
      const text = await decodeRegion(imgEl, sx, sy, sw, sh, CROP_SCALES);
      if (text) onCropRead({ text });
      else setError("Couldn't read a licence disk barcode in that crop. Drag the crop tighter around the square barcode and try Read barcode again, or use Read whole image.");
    } finally {
      setLoading(false);
    }
  }

  async function readWholeImage() {
    const imgEl = imgRef.current;
    if (!imgEl || !dims) return;
    setLoading(true); setError("");
    try {
      const fit = Math.min(1, 1600 / Math.max(dims.w, dims.h));
      const text = await decodeRegion(imgEl, 0, 0, dims.w, dims.h, WHOLE_SCALES.map(s => fit * s));
      if (text) onCropRead({ text });
      else setError("Couldn't read a licence disk barcode in the whole photo. Crop the square barcode tighter and try Read barcode again.");
    } finally {
      setLoading(false);
    }
  }

  function pointerDown(e: React.PointerEvent, corner: Corner) {
    e.preventDefault();
    if (!boxRef.current) return;
    drag.current = { corner, startX: e.clientX, startY: e.clientY, orig: crop };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  if (!image) {
    return (
      <div className="mt-3">
        <input ref={fileRef} type="file" accept="image/*" aria-label="Photo of the licence disk" className="sr-only" onChange={event => { const f = event.target.files?.[0]; event.target.value = ""; if (f) void loadImage(f); }} />
        <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={loading} className="h-9 rounded-lg px-3 text-xs font-semibold">
          {loading ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <ImageUp size={13} className="mr-1.5" />}Choose a photo
        </Button>
        <p className="text-xs leading-5 text-muted-foreground">Select a photo of the PDF417 barcode on the licence disk — from the phone that took it or a picture on the shop PC. It works on a plain http address, no camera needed.</p>
        {error && <p role="alert" className="mt-2 rounded-lg bg-destructive/5 p-2.5 text-xs leading-5 text-destructive">{error}</p>}
      </div>
    );
  }

  const boxW = boxRef.current?.clientWidth ?? 360;
  const boxH = boxRef.current?.clientHeight ?? 270;
  const cropPx = {
    left: crop.left * boxW,
    top: crop.top * boxH,
    width: crop.width * boxW,
    height: crop.height * boxH,
  };

  return (
    <div className="mt-3 space-y-2">
      <div ref={boxRef} className="relative overflow-hidden rounded-xl bg-black" style={{ width: boxW, aspectRatio: "4/3" }}>
        <img src={previewUrl} className="h-full w-full object-contain" alt="Licence disk" />
        <div className="pointer-events-none absolute inset-0" style={{ boxShadow: "inset 0 0 0 9999px rgba(0,0,0,0.62)" }} />
        <div
          className="crop-body absolute rounded-sm border-2 border-solid border-white/80 shadow-sm"
          style={{ left: `${crop.left * 100}%`, top: `${crop.top * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }}
          onPointerDown={e => pointerDown(e, "move")}
          role="button"
          aria-label="Drag to move the crop"
          tabIndex={0}
        />
        {(["nw", "ne", "sw", "se"] as Corner[]).map(corner => {
          const x = corner.includes("w") ? cropPx.left : cropPx.left + cropPx.width - 10;
          const y = corner.includes("n") ? cropPx.top : cropPx.top + cropPx.height - 10;
          return (
            <div
              key={corner}
              className="absolute h-3 w-3 cursor-pointer touch-none rounded-full border border-primary bg-white shadow-md outline-none"
              style={{ left: `${x}px`, top: `${y}px` }}
              onPointerDown={e => pointerDown(e, corner)}
              aria-label={`Resize from ${corner} corner`}
              tabIndex={-1}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={loading} onClick={readCrop} className="h-9 rounded-lg px-3 text-xs font-semibold">
          {loading ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Camera size={13} className="mr-1.5" />}Read barcode
        </Button>
        <Button variant="outline" disabled={loading} onClick={readWholeImage} className="h-9 rounded-lg px-3 text-xs">
          Read whole image
        </Button>
        <Button variant="ghost" onClick={onCloseCrop} className="h-9 rounded-lg px-3 text-xs">Cancel</Button>
      </div>
      {error && <p role="alert" className="rounded-lg bg-destructive/5 p-2.5 text-xs leading-5 text-destructive">{error}</p>}
    </div>
  );
}
