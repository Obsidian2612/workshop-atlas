import { fail } from "./store";
import { torqueUnits, type TorqueOrigin, type TorqueSpec, type TorqueUnit } from "../../src/lib/workshop-types";

/*
 * Tightening torques are copied from the licensed program the same way repair
 * times are: one row per fastener, with the unit spelled out (`90 Nm`,
 * `66 lbf·ft`, `8 lbf·in`, `9 kgf·m`). A row may also carry a stage
 * (`stage 2`, `2nd stage` or a separate numeric column). Nothing is guessed
 * without a recognised unit, so ordinary repair-time rows and specification
 * lines are left alone.
 */

const unitAliases: Record<string, TorqueUnit> = {
  nm: "Nm",
  newtonmeter: "Nm",
  newtonmetre: "Nm",
  newtonmeters: "Nm",
  newtonmetres: "Nm",
  lbfft: "lbf·ft",
  lbft: "lbf·ft",
  ftlb: "lbf·ft",
  ftlbf: "lbf·ft",
  ftlbs: "lbf·ft",
  lbsft: "lbf·ft",
  footpound: "lbf·ft",
  footpounds: "lbf·ft",
  lbfin: "lbf·in",
  lbin: "lbf·in",
  inlb: "lbf·in",
  inlbs: "lbf·in",
  lbsin: "lbf·in",
  inchpound: "lbf·in",
  inchpounds: "lbf·in",
  kgfm: "kgf·m",
  kgm: "kgf·m",
  kilogrammeter: "kgf·m",
  kilogrammetre: "kgf·m",
};

export function normalizeTorqueUnit(value: unknown): TorqueUnit | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase().replace(/[·.\s_-]/g, "");
  const direct = torqueUnits.find(unit => unit.toLowerCase().replace(/[·.\s_-]/g, "") === key);
  return direct ?? unitAliases[key] ?? null;
}

export function cleanTorqueValue(value: unknown): number | null {
  const numeric = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value.replace(",", ".")) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 2000) return null;
  return Math.round(numeric * 100) / 100;
}

/** Only a plain http(s) page can be linked back to; anything else is dropped. */
function cleanPageUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.toString().slice(0, 1000);
  } catch { return ""; }
}

function cleanOrigin(value: unknown): TorqueOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const text = (field: unknown, length: number) => typeof field === "string" ? field.replace(/\s+/g, " ").trim().slice(0, length) : "";
  const provider = text(row.provider, 60);
  const title = text(row.title, 200);
  const url = cleanPageUrl(row.url);
  if (!provider && !title && !url) return undefined;
  return { provider, title, url };
}

export function sanitizeTorqueSpecs(input: unknown): TorqueSpec[] {
  if (!Array.isArray(input)) fail(400, "Send the torque rows as a list");
  if (input.length > 200) fail(400, "Keep at most 200 torque rows per vehicle");
  return input.map((item, index) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const fastener = typeof row.fastener === "string" ? row.fastener.replace(/\s+/g, " ").trim() : "";
    if (fastener.length < 2 || fastener.length > 200) fail(400, `Torque row ${index + 1} needs a fastener name of 2–200 characters`);
    const stage = typeof row.stage === "string" ? row.stage.replace(/\s+/g, " ").trim() : "";
    if (stage.length > 40) fail(400, `Torque row ${index + 1} has an overlong stage`);
    const value = cleanTorqueValue(row.value);
    if (value === null) fail(400, `Torque row ${index + 1} needs a value between 0 and 2000`);
    const unit = normalizeTorqueUnit(row.unit);
    if (!unit) fail(400, `Torque row ${index + 1} needs a unit: ${torqueUnits.join(", ")}`);
    const spec: TorqueSpec = { fastener, stage, value, unit };
    const origin = cleanOrigin(row.origin);
    if (origin) spec.origin = origin;
    return spec;
  });
}

/** The identity of a torque row across lookups, edits and checks. */
export function torqueRowKey(spec: Pick<TorqueSpec, "fastener" | "stage">): string {
  return `${spec.fastener.toLowerCase()}|${spec.stage.toLowerCase()}`;
}

/*
 * A row saved again with the same value keeps the page it came from and the
 * people who added and checked it. A changed value is a different number, so the
 * old provenance no longer backs it and is dropped rather than left to mislead.
 */
function carryForward(spec: TorqueSpec, prior?: TorqueSpec): TorqueSpec {
  if (!prior || prior.value !== spec.value || prior.unit !== spec.unit) return spec;
  const carried: TorqueSpec = { ...spec };
  const origin = spec.origin ?? prior.origin;
  if (origin) carried.origin = origin;
  if (prior.addedBy) carried.addedBy = prior.addedBy;
  if (prior.addedAt) carried.addedAt = prior.addedAt;
  // A check is only ever set together with the date it was made.
  if (prior.checkedAt) {
    carried.checkedBy = prior.checkedBy;
    carried.checkedAt = prior.checkedAt;
    carried.checkedAgainst = prior.checkedAgainst;
  }
  return carried;
}

/** Add or update rows by fastener and stage, keeping the rows already on the vehicle. */
export function mergeTorqueSpecs(existing: TorqueSpec[], incoming: TorqueSpec[]): TorqueSpec[] {
  const merged = new Map(existing.map(spec => [torqueRowKey(spec), spec]));
  for (const spec of incoming) merged.set(torqueRowKey(spec), carryForward(spec, merged.get(torqueRowKey(spec))));
  return [...merged.values()];
}

/** A full-list save: the rows sent become the list, repeating the history of any row it repeats. */
export function replaceTorqueSpecs(existing: TorqueSpec[], incoming: TorqueSpec[]): TorqueSpec[] {
  const prior = new Map(existing.map(spec => [torqueRowKey(spec), spec]));
  return incoming.map(spec => carryForward(spec, prior.get(torqueRowKey(spec))));
}

/** Record who added the rows and when; a row that already carries a stamp keeps it. */
export function stampTorqueSpecs(specs: TorqueSpec[], author: string): TorqueSpec[] {
  const addedAt = new Date().toISOString();
  return specs.map(spec => ({ addedBy: author, addedAt, ...spec }));
}

const unitMatchers: { pattern: RegExp; unit: TorqueUnit }[] = [
  { pattern: /(?<![a-z])(?:lbf?|lbs?)\s*[.·-]?\s*(?:ft|foot|feet)\b|(?<![a-z])(?:ft|foot|feet)\s*[.·-]?\s*(?:lbf?|lbs?)\b/gi, unit: "lbf·ft" },
  { pattern: /(?<![a-z])(?:lbf?|lbs?)\s*[.·-]?\s*(?:in|inch|inches)\b|(?<![a-z])(?:in|inch|inches)\s*[.·-]?\s*(?:lbf?|lbs?)\b/gi, unit: "lbf·in" },
  { pattern: /(?<![a-z])(?:kgf?|kilograms?)\s*[.·-]?\s*(?:m|met(?:er|re)s?)\b/gi, unit: "kgf·m" },
  { pattern: /(?<![a-z])(?:n|newtons?)\s*[.·-]?\s*(?:m|met(?:er|re)s?)\b/gi, unit: "Nm" },
];

function findUnit(line: string): { unit: TorqueUnit; index: number } | null {
  let found: { unit: TorqueUnit; index: number } | null = null;
  for (const matcher of unitMatchers) {
    matcher.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = matcher.pattern.exec(line))) {
      if (!found || match.index > found.index) found = { unit: matcher.unit, index: match.index };
      if (!match[0].length) matcher.pattern.lastIndex++;
    }
  }
  return found;
}

const stageWords: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5" };
const notFastener = /^(?:tighten|tightening|torque|see|refer|note|caution|warning|fastener|description|component|application|item|value|unit|stage|step)(?:\b|$)/i;

function splitStage(raw: string) {
  let stage = "";
  let text = raw;
  const labelled = text.match(/(?:^|[\s,;:()[\]|/\\-])(?:stage|step)\s*#?\s*(\d{1,2}|one|two|three|four|five)\b\s*[).:]?/i);
  if (labelled) {
    const value = labelled[1].toLowerCase();
    stage = stageWords[value] ?? value;
    text = `${text.slice(0, labelled.index)} ${text.slice((labelled.index ?? 0) + labelled[0].length)}`;
  } else {
    const ordinal = text.match(/(?:^|[\s,;:()[\]|/\\-])(\d{1,2})(?:st|nd|rd|th)\s+(?:stage|step)\b\s*[).:]?/i);
    if (ordinal) {
      stage = ordinal[1];
      text = `${text.slice(0, ordinal.index)} ${text.slice((ordinal.index ?? 0) + ordinal[0].length)}`;
    }
  }
  if (!stage) {
    // A tab, pipe or extra-wide gap before a bare number is a stage column.
    const cell = text.match(/(?:\t|\s{2,}|\|)\s*(\d{1,2})\s*$/);
    if (cell) { stage = cell[1]; text = text.slice(0, cell.index); }
  }
  return { stage, fastener: text.replace(/\s+/g, " ").trim() };
}

function cleanFastener(raw: string) {
  return raw.replace(/\s+/g, " ").replace(/^[\s|;:,.\-–—•]+/, "").replace(/[\s|;:,.\-–—•]+$/, "").trim();
}

export function parseTorqueLine(line: string): TorqueSpec | null {
  const unit = findUnit(line);
  if (!unit) return null;
  const before = line.slice(0, unit.index).trimEnd();
  // A pipe- or colon-separated table leaves a separator between the value and
  // the unit (`| 95 | Nm`), so allow one trailing separator before the unit.
  const valueMatch = before.match(/(\d{1,4}(?:[.,]\d{1,3})?)\s*[|,;:]?\s*$/);
  if (!valueMatch || valueMatch.index === undefined) return null;
  const value = cleanTorqueValue(valueMatch[1]);
  if (value === null) return null;
  const { stage, fastener } = splitStage(before.slice(0, valueMatch.index));
  const name = cleanFastener(fastener);
  if (name.length < 2 || name.length > 200) return null;
  if (!/[a-z]/i.test(name)) return null;
  if (notFastener.test(name)) return null;
  if (/^(?:engine|max(?:imum)?|rated|output)\s+torque$/i.test(name)) return null;
  return { fastener: name, stage, value, unit: unit.unit };
}

/** A row read from a CSV table: the four torque columns, plus where it came from. */
export interface TorqueCsvRow extends TorqueSpec {
  sourceTitle?: string;
  sourceUrl?: string;
  snippet?: string;
}

/*
 * The AI lookups answer with a CSV table so the same rows can be read here, kept in
 * a spreadsheet, or pasted back into the app. The headings decide the columns, so
 * their order does not matter and the source columns are optional.
 */
const csvHeadings: Record<string, string[]> = {
  fastener: ["fastener", "component", "bolt", "description", "item", "part"],
  stage: ["stage", "step"],
  value: ["value", "torque", "torquevalue"],
  unit: ["unit", "units"],
  sourceTitle: ["sourcetitle", "source", "sourcename"],
  sourceUrl: ["sourceurl", "url", "link", "sourceaddress"],
  snippet: ["snippet", "quote", "note", "notes"],
};

/** Split CSV text into cells, honouring quoted fields that contain commas. */
function csvCells(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { cell += '"'; index++; }
        else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (char !== "\r") cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(cells => cells.some(value => value.trim()));
}

/** A markdown-style table row (`| a | b |`) is split on its pipes instead. */
function pipeCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
}

/*
 * Models often answer with a markdown table even when asked for CSV, and piped
 * rows cannot be read by the comma splitter, so both shapes are collected here.
 */
function tableRows(source: string): string[][] {
  const lines = source.replace(/```[a-z]*/gi, "").split(/\r?\n/);
  const rows = csvCells(lines.filter(line => !line.trim().startsWith("|")).join("\n"));
  for (const line of lines) if (line.trim().startsWith("|")) rows.push(pipeCells(line));
  return rows;
}

/** A unit written into a heading (`Torque (Nm)`) applies to the whole column. */
function headerUnit(cells: string[]): TorqueUnit | null {
  for (const cell of cells) {
    const direct = normalizeTorqueUnit(cell);
    if (direct) return direct;
    const bracketed = cell.match(/[（(]([^)）]*)[)）]/);
    const inside = bracketed ? normalizeTorqueUnit(bracketed[1]) : null;
    if (inside) return inside;
  }
  return null;
}

export function parseTorqueCsv(source: string): TorqueCsvRow[] {
  const rows = tableRows(source);
  const heading = (cell: string) => cell.trim().toLowerCase().replace(/[^a-z]/g, "");
  const matchesAlias = (key: string, alias: string) => key === alias || key.startsWith(alias) || key.endsWith(alias);
  let columns: Record<string, number> | null = null;
  let fallbackUnit: TorqueUnit | null = null;
  const specs: TorqueCsvRow[] = [];
  const positions = new Map<string, number>();
  for (const row of rows) {
    const keys = row.map(heading);
    if (!columns) {
      // The header row is whichever line names a fastener and a value; the unit
      // may sit in its own column or in the value heading ("Torque (Nm)").
      const has = (field: string) => keys.some(key => csvHeadings[field].some(alias => matchesAlias(key, alias)));
      if (!has("fastener") || !has("value")) continue;
      columns = {};
      keys.forEach((key, index) => {
        for (const [field, aliases] of Object.entries(csvHeadings)) {
          if (aliases.includes(key) && columns![field] === undefined) columns![field] = index;
        }
      });
      // Only after the exact headings are placed may a looser heading claim a column.
      keys.forEach((key, index) => {
        for (const [field, aliases] of Object.entries(csvHeadings)) {
          if (columns![field] === undefined && aliases.some(alias => matchesAlias(key, alias))) columns![field] = index;
        }
      });
      fallbackUnit = headerUnit(row);
      continue;
    }
    const cell = (field: string) => {
      const index = columns![field];
      return index === undefined ? "" : (row[index] || "").trim();
    };
    const fastener = cell("fastener").replace(/\s+/g, " ").trim().slice(0, 200);
    if (fastener.length < 2 || !/[a-z]/i.test(fastener) || notFastener.test(fastener)) continue;
    // A value column may carry the unit with it (`90 Nm`) when there is no unit column.
    const rawValue = cell("value");
    const split = rawValue.match(/^(\d{1,4}(?:[.,]\d{1,3})?)\s*(.*)$/);
    const value = cleanTorqueValue(split?.[1] ?? rawValue);
    const unit = normalizeTorqueUnit(cell("unit")) ?? normalizeTorqueUnit(split?.[2] ?? "") ?? fallbackUnit;
    if (value === null || !unit) continue;
    const spec: TorqueCsvRow = { fastener, stage: cell("stage").slice(0, 40), value, unit };
    const sourceTitle = cell("sourceTitle").slice(0, 200);
    const sourceUrl = cell("sourceUrl").slice(0, 1000);
    const snippet = cell("snippet").slice(0, 400);
    if (sourceTitle) spec.sourceTitle = sourceTitle;
    if (sourceUrl) spec.sourceUrl = sourceUrl;
    if (snippet) spec.snippet = snippet;
    const key = torqueRowKey({ fastener, stage: spec.stage });
    const at = positions.get(key);
    if (at === undefined) { positions.set(key, specs.length); specs.push(spec); }
    else specs[at] = spec;
  }
  return specs;
}

export function parseTorqueText(source: string): TorqueSpec[] {
  // A pasted CSV table — including one an AI wrote — is read by its headings, so a
  // comma inside a fastener name does not swallow the stage.
  const table = parseTorqueCsv(source);
  if (table.length) return table.map(row => {
    const spec: TorqueSpec = { fastener: row.fastener, stage: row.stage, value: row.value, unit: row.unit };
    // A pasted table may carry the page it was copied from; keep it with the row.
    const origin = cleanOrigin({ title: row.sourceTitle, url: row.sourceUrl, provider: "Pasted table" });
    if (origin) spec.origin = origin;
    return spec;
  });
  const lines = source
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 2000);
  const specs: TorqueSpec[] = [];
  const positions = new Map<string, number>();
  for (const line of lines) {
    const spec = parseTorqueLine(line);
    if (!spec) continue;
    const key = torqueRowKey(spec);
    const at = positions.get(key);
    if (at === undefined) { positions.set(key, specs.length); specs.push(spec); }
    else specs[at] = spec;
  }
  return specs;
}
