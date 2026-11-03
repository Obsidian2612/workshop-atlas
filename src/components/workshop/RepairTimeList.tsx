import { Pencil } from "lucide-react";
import type { RepairTimeEntry } from "@/lib/workshop-types";
import { prettyDate } from "./primitives";

/*
 * Times captured for a day that has passed are listed first, then anything
 * scheduled ahead, so a booked job is visible next to the history it extends.
 */
export default function RepairTimeList({ entries, canEdit, formatMinutes, onEdit }: {
  entries: RepairTimeEntry[];
  canEdit: boolean;
  formatMinutes: (minutes: number) => string;
  onEdit: (entry: RepairTimeEntry) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const groups = [
    { key: "recorded", label: "Recorded", rows: entries.filter(entry => !entry.capturedAt || entry.capturedAt <= today) },
    { key: "upcoming", label: "Upcoming", rows: entries.filter(entry => entry.capturedAt && entry.capturedAt > today).sort((a, b) => (a.capturedAt || "").localeCompare(b.capturedAt || "")) },
  ].filter(group => group.rows.length);

  return <div className="space-y-3">{groups.map(group => <div key={group.key}>
    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{group.label} · {group.rows.length}</p>
    <div className="divide-y divide-border rounded-xl border border-border">{group.rows.map((entry, index) => <div key={`${entry.operation}-${index}`} className="px-4 py-3 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="break-words font-medium">{entry.operation}</span>
            {entry.scope && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">{entry.scope}</span>}
          </p>
          {entry.capturedAt && <p className="mt-1 text-[10px] text-muted-foreground">Captured for {prettyDate(entry.capturedAt)}</p>}
          {entry.notes && <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{entry.notes}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-semibold text-primary">⏱ {formatMinutes(entry.minutes)}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{entry.source}</span>
          {canEdit && <button aria-label={`Edit ${entry.operation}`} onClick={() => onEdit(entry)} className="text-primary"><Pencil size={13} /></button>}
        </div>
      </div>
      {entry.includes?.length ? <div className="mt-2 border-l border-border pl-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Includes · {formatMinutes(entry.includes.reduce((sum, step) => sum + step.minutes, 0))}</p>
        <ul className="mt-1 space-y-1">{entry.includes.map((step, at) => <li key={`${step.label}-${at}`} className="flex items-baseline justify-between gap-3 text-[11px]">
          <span className="min-w-0 break-words text-muted-foreground">{step.label}{step.scope && <span className="ml-1.5 rounded bg-background px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{step.scope}</span>}</span>
          <span className="shrink-0 font-medium text-foreground">{formatMinutes(step.minutes)}</span>
        </li>)}</ul>
      </div> : null}
    </div>)}</div>
  </div>)}</div>;
}
