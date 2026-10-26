import { fail } from "./store";
import { torqueUnits, type TorqueSpec, type TorqueUnit } from "../../src/lib/workshop-types";

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
    return { fastener, stage, value, unit };
  });
}

/** Replace rows with the same fastener and stage, keeping the existing order. */
export function mergeTorqueSpecs(existing: TorqueSpec[], incoming: TorqueSpec[]): TorqueSpec[] {
  const key = (spec: TorqueSpec) => `${spec.fastener.toLowerCase()}|${spec.stage.toLowerCase()}`;
  const merged = new Map(existing.map(spec => [key(spec), spec]));
  for (const spec of incoming) merged.set(key(spec), spec);
  return [...merged.values()];
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

export function parseTorqueText(source: string): TorqueSpec[] {
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
    const key = `${spec.fastener.toLowerCase()}|${spec.stage.toLowerCase()}`;
    const at = positions.get(key);
    if (at === undefined) { positions.set(key, specs.length); specs.push(spec); }
    else specs[at] = spec;
  }
  return specs;
}
