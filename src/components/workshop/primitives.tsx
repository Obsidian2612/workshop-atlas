import type { ReactNode } from "react";
import { ArrowUpRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("rounded-2xl border border-border bg-white shadow-[0_2px_8px_rgba(24,52,47,0.025)]", className)}>{children}</section>;
}
export function PanelHeading({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-5 sm:px-6"><div><h2 className="font-heading text-base font-bold tracking-tight">{title}</h2>{subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}</div>{action}</div>;
}
export function EmptyState({ title, description, action, compact = false }: { title: string; description: string; action?: { label: string; onClick: () => void }; compact?: boolean }) {
  return <div className={cn("flex flex-col items-center justify-center px-6 text-center", compact ? "py-7" : "py-12")}><img src="/assets/vehicle-library.png" alt="Vehicle folders, checklist and workshop tools" className={cn("mix-blend-multiply", compact ? "h-24 w-24" : "h-36 w-36")} /><h3 className="mt-3 font-heading text-base font-bold">{title}</h3><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>{action && <Button onClick={action.onClick} variant="outline" className="mt-5 h-10 rounded-lg border-primary/20 bg-primary/5 px-4 text-xs font-semibold text-primary hover:bg-primary/10"><Plus size={15} className="mr-2" />{action.label}</Button>}</div>;
}
export function SmallLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button onClick={onClick} className="flex items-center gap-1.5 whitespace-nowrap rounded-md text-xs font-semibold text-primary hover:text-primary/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">{children}<ArrowUpRight size={14} /></button>;
}
export function Pick({ value, onChange, options, label }: { value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; label: string }) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="h-11 rounded-lg border-border bg-white text-sm"><SelectValue placeholder={label} /></SelectTrigger><SelectContent className="rounded-xl border-border bg-white shadow-xl">{options.map(o => <SelectItem key={o.value} value={o.value} className="rounded-md py-2.5 text-sm">{o.label}</SelectItem>)}</SelectContent></Select>;
}
export function prettyDate(value: string) {
  return new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
export function fileSize(value: number) { return value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`; }
