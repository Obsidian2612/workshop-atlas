import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat } from "@zxing/library";
import { Camera, ImageUp, Loader2, Move } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { parseLicenceDisk, licenceDiskHasDetails, type LicenceDiskDetails } from "@/lib/licence-disk";

type CropRect = { left: number; top: number; width: number; height: number };
type Corner = "nw" | "ne" | "sw" | "se" | "move";

// Crop rectangles are kept in *image* fractions, never in preview pixels, so the
// frame stays on the same part of the photo when the panel is resized.
// A licence-disk PDF417 is a wide block of bars, so the fallback is wide too;
// when the photo allows it, suggestCrop() places the box on the bars.
const DEFAULT_CROP: CropRect = { left: 0.1, top: 0.33, width: 0.8, height: 0.34 };

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

function clampCrop(rect: CropRect): CropRect {
  const left = clamp01(rect.left);
  const top = clamp01(rect.top);
  return {
    left,
    top,
    width: Math.max(0.04, Math.min(clamp01(rect.width), 1 - left)),
    height: Math.max(0.04, Math.min(clamp01(rect.height), 1 - top)),
  };
}

function densityProfile(dark: Uint8Array, w: number, h: number, axis: "rows" | "cols", fromY = 0, toY = h): Float32Array {
  if (axis === "rows") {
    const out = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      let count = 0;
      for (let x = 0; x < w; x++) count += dark[y * w + x];
      out[y] = count / Math.max(1, w);
    }
    return out;
  }
  const out = new Float32Array(w);
  const span = Math.max(1, toY - fromY);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = fromY; y < toY; y++) count += dark[y * w + x];
    out[x] = count / span;
  }
  return out;
}

function longestBand(profile: Float32Array, cut: number): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  let start = -1;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] >= cut) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (!best || i - start > best.end - best.start) best = { start, end: i };
      start = -1;
    }
  }
  if (start >= 0 && (!best || profile.length - start > best.end - best.start)) best = { start, end: profile.length };
  return best;
}

// Columns of bars have white gaps, so a plain run test fragments: take the
// widest cluster instead, bridging gaps no wider than maxGap.
function clusterSpan(profile: Float32Array, cut: number, maxGap: number): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  let start = -1, last = -1;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] > cut) {
      if (start < 0) start = i;
      else if (i - last > maxGap) {
        if (!best || last + 1 - start > best.end - best.start) best = { start, end: last + 1 };
        start = i;
      }
      last = i;
    }
  }
  if (start >= 0 && (!best || last + 1 - start > best.end - best.start)) best = { start, end: last + 1 };
  return best;
}

// Finds the densest block of dark bars in the photo and returns it in image
// fractions. Best effort only: null means "keep the default frame".
function suggestCrop(img: HTMLImageElement): CropRect | null {
  const W = img.naturalWidth, H = img.naturalHeight;
  if (!W || !H) return null;
  const scale = Math.min(1, 180 / Math.max(W, H));
  const w = Math.max(8, Math.round(W * scale));
  const h = Math.max(8, Math.round(H * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
  const dark = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < dark.length; i++, p += 4) {
    dark[i] = pixels[p] * 0.299 + pixels[p + 1] * 0.587 + pixels[p + 2] * 0.114 < 128 ? 1 : 0;
  }
  // Rows of a PDF417 are dense bands of bars, so cut relative to the busiest row.
  const rowProfile = densityProfile(dark, w, h, "rows");
  let rowPeak = 0;
  for (const value of rowProfile) if (value > rowPeak) rowPeak = value;
  if (rowPeak <= 0) return null;
  const rows = longestBand(rowProfile, rowPeak * 0.55);
  if (!rows) return null;
  // Columns are bars with white gaps, so a column inside the symbol can be
  // almost empty: ask only that it holds some bars, within the row band.
  const colProfile = densityProfile(dark, w, h, "cols", rows.start, rows.end);
  const cols = clusterSpan(colProfile, 0.02, Math.max(3, Math.round(w * 0.06)));
  if (!cols) return null;
  const width = (cols.end - cols.start) / w;
  const height = (rows.end - rows.start) / h;
  if (width < 0.15 || height < 0.04) return null;
  const pad = 0.02;
  const left = Math.max(0, cols.start / w - pad);
  const top = Math.max(0, rows.start / h - pad);
  const right = Math.min(1, cols.end / w + pad);
  const bottom = Math.min(1, rows.end / h + pad);
  return { left, top, width: Math.max(0.05, right - left), height: Math.max(0.03, bottom - top) };
}

// The crop lives in preview-box fractions, and the photo is letterboxed inside
// that box, so an image-space rectangle has to be mapped through the same fit.
function imageRectToBox(size: { w: number; h: number }, boxW: number, boxH: number, rect: CropRect): CropRect {
  const fit = Math.min(boxW / size.w, boxH / size.h);
  const offsetX = (boxW - fit * size.w) / 2;
  const offsetY = (boxH - fit * size.h) / 2;
  return {
    left: (offsetX + rect.left * fit * size.w) / boxW,
    top: (offsetY + rect.top * fit * size.h) / boxH,
    width: (rect.width * fit * size.w) / boxW,
    height: (rect.height * fit * size.h) / boxH,
  };
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
  const [cameraBlocked, setCameraBlocked] = useState(false);
  const [error, setError] = useState("");
  const [photoCropOpen, setPhotoCropOpen] = useState(false);

  useEffect(() => {
    let active = true;
    if (!videoEl) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      // Serving over plain http on the shop network is a normal way to run this,
      // not a fault: offer the photo path instead of an error.
      setStarting(false);
      setCameraBlocked(true);
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
        {!photoCropOpen && cameraBlocked && (
          <p className="rounded-lg bg-muted p-3 text-xs leading-5 text-muted-foreground">
            This copy is served over a plain <span className="font-semibold text-foreground">http</span> address, so the browser will not open the camera here. Read a photo of the disk instead — it works on this address, including a photo taken on a phone.
          </p>
        )}
        {!photoCropOpen && !cameraBlocked && (
          <div className="relative mt-2 overflow-hidden rounded-xl bg-black">
            <video ref={setVideoEl} muted playsInline className="aspect-[4/3] w-full object-cover" />
            {!error && <div className="pointer-events-none absolute inset-6 rounded-lg border-2 border-dashed border-white/60" />}
            {starting && !error && <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs font-medium text-white"><Loader2 size={16} className="mr-2 animate-spin" />Starting the camera…</div>}
            {error && <div className="absolute inset-0 flex items-center justify-center bg-black/40 p-3"><p className="text-xs text-white/90 leading-5">{error}</p></div>}
          </div>
        )}
        {error && !photoCropOpen && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-xs leading-5 text-destructive">{error}</p>}
        {!error && !cameraBlocked && !photoCropOpen && <p className="text-xs leading-5 text-muted-foreground">Hold the disk steady in good light. Only the barcode is read, and the details it holds are shown for you to check before saving. On a plain http address the camera is blocked — choose a photo instead.</p>}
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
  const [autoFramed, setAutoFramed] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);
  const [boxSize, setBoxSize] = useState({ w: 360, h: 270 });
  const fileRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ corner: Corner; startX: number; startY: number; orig: CropRect } | null>(null);

  const previewUrl = useMemo(() => (image ? URL.createObjectURL(image) : ""), [image]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = drag.current;
      const box = boxRef.current;
      const imgEl = imgRef.current;
      if (!d || !box || !imgEl) return;
      // Pointer travel is in preview pixels; the crop is in image fractions, so
      // scale by the photo's rendered size rather than the box's.
      const fit = Math.min(box.clientWidth / imgEl.naturalWidth, box.clientHeight / imgEl.naturalHeight);
      setCrop(prev => applyDrag(prev, d.corner, e.clientX - d.startX, e.clientY - d.startY, fit * imgEl.naturalWidth, fit * imgEl.naturalHeight));
    }
    function onUp() { drag.current = null; }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, []);

  // Track the preview's size so the overlay can be re-projected whenever the
  // panel changes width; the frame is derived from image fractions, so it lands
  // back on the barcode without re-detecting it.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !image) return;
    const measure = () => setBoxSize({ w: box.clientWidth, h: box.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [image]);

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
      const size = { w: img.naturalWidth, h: img.naturalHeight };
      setDims(size);
      setImage(file);
      // The suggestion is already in image fractions, so reloading the photo or
      // resizing the panel keeps the frame snapped to the same bars.
      const suggestion = suggestCrop(img);
      const target = clampCrop(suggestion ?? DEFAULT_CROP);
      setCrop(target);
      setAutoFramed(!!suggestion);
      setHintVisible(true);
      void autoRead(target);
    } catch (loadError) {
      setError((loadError as Error).message || "That file could not be opened as an image.");
    } finally {
      URL.revokeObjectURL(url);
      setLoading(false);
    }
  }

  // Reads straight from the loaded <img>, never from state, so the automatic
  // attempt that runs inside loadImage() sees the new photo, not the old dims.
  async function attemptCrop(rect: CropRect): Promise<string | null> {
    const imgEl = imgRef.current;
    if (!imgEl) return null;
    const W = imgEl.naturalWidth, H = imgEl.naturalHeight;
    let sx = rect.left * W, sy = rect.top * H;
    let sw = rect.width * W, sh = rect.height * H;
    sx = Math.max(0, Math.min(W - 1, sx));
    sy = Math.max(0, Math.min(H - 1, sy));
    sw = Math.min(W - sx, sw);
    sh = Math.min(H - sy, sh);
    if (sw < 8 || sh < 8) return null;
    return decodeRegion(imgEl, sx, sy, sw, sh, CROP_SCALES);
  }

  async function attemptWhole(): Promise<string | null> {
    const imgEl = imgRef.current;
    if (!imgEl) return null;
    const W = imgEl.naturalWidth, H = imgEl.naturalHeight;
    const fit = Math.min(1, 1600 / Math.max(W, H));
    return decodeRegion(imgEl, 0, 0, W, H, WHOLE_SCALES.map(s => fit * s));
  }

  async function readCrop() {
    setLoading(true); setError("");
    try {
      const text = await attemptCrop(crop);
      if (text) onCropRead({ text });
      else setError("Couldn't read a licence disk barcode in that crop. Drag the crop tighter around the square barcode and try Read barcode again, or use Read whole image.");
    } finally {
      setLoading(false);
    }
  }

  async function readWholeImage() {
    setLoading(true); setError("");
    try {
      const text = await attemptWhole();
      if (text) onCropRead({ text });
      else setError("Couldn't read a licence disk barcode in the whole photo. Crop the square barcode tighter and try Read barcode again.");
    } finally {
      setLoading(false);
    }
  }

  // A good photo should need no button press: try the framed crop, then the
  // whole photo, and only fall back to asking when both come up empty.
  async function autoRead(rect: CropRect) {
    setLoading(true);
    try {
      const text = (await attemptCrop(rect)) ?? (await attemptWhole());
      if (text) onCropRead({ text });
      else setError("Couldn't read the barcode straight away. If the box is off the bars, drag it or pull a corner, then press Read barcode.");
    } finally {
      setLoading(false);
    }
  }

  function pointerDown(e: React.PointerEvent, corner: Corner) {
    e.preventDefault();
    setHintVisible(false);
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

  const boxW = boxSize.w;
  const boxH = boxSize.h;
  // Project the image-space frame into the letterboxed preview. Recomputed on
  // every render, so a resize moves the box with the photo instead of off it.
  const preview = clampCrop(
    dims ? imageRectToBox(dims, boxW, boxH, crop) : { left: crop.left, top: crop.top, width: crop.width, height: crop.height },
  );
  const cropPx = {
    left: preview.left * boxW,
    top: preview.top * boxH,
    width: preview.width * boxW,
    height: preview.height * boxH,
  };

  return (
    <div className="mt-3 space-y-2">
      {hintVisible && (
        <div className="flex items-start gap-2 rounded-lg bg-primary/5 p-2.5 text-xs leading-5" role="status">
          <Move size={14} className="mt-0.5 shrink-0 text-primary" />
          <span>
            {autoFramed
              ? "We framed the barcode for you. Drag the box to move it, or pull a corner to tighten it around the bars, then press Read barcode."
              : "Drag the box over the block of bars on the licence disk, pull a corner to tighten it, then press Read barcode."}
          </span>
        </div>
      )}
      <div ref={boxRef} className="relative overflow-hidden rounded-xl bg-black" style={{ width: boxW, aspectRatio: "4/3" }}>
        <img src={previewUrl} className="h-full w-full object-contain" alt="Licence disk" />
        <div className="pointer-events-none absolute inset-0" style={{ boxShadow: "inset 0 0 0 9999px rgba(0,0,0,0.62)" }} />
        <div
          className="crop-body absolute rounded-sm border-2 border-solid border-white/80 shadow-sm"
          style={{ left: `${preview.left * 100}%`, top: `${preview.top * 100}%`, width: `${preview.width * 100}%`, height: `${preview.height * 100}%` }}
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
