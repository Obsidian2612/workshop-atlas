import { fail } from "./store";
import { extractPdfText } from "./pdf-text";
import type { RepairSheetOperation } from "../../src/lib/workshop-types";

/*
 * Repair-time sheets print one operation per row: a code such as `A1.0100`, a
 * description, an operation type (`R & I`, `C & A`, `Check`), the hours as a
 * decimal with a comma or dot, and often a price. Printed sheets put the code
 * and description in the left column and `type : hours price` in the right one,
 * so rows are read cell-first and fall back to the joined line when a generator
 * lays the row out as a single run of text. A row may also wrap, with the hours
 * on the following line; those rows are kept as pending until the hours arrive.
 *
 * Pasted rows from the program use the same shape, but plain description-and-
 * hours lines (`Engine & transmission complete 5.70`) are accepted as well.
 */

const codePattern = /^([A-Z]{1,2}\d{1,3}\.\d{1,4})\b[ .:-]{0,4}(.*)$/;
const typePattern = /\b(R\s*&\s*I|C\s*&\s*A|R\s*\/\s*I|C\s*\/\s*A|CHECK|INSPECT|ADJUST|RENEW|REPLACE|BLEED|OVERHAUL|MEASURE)\b\s*:?/i;
const hoursPattern = /(?:^|[^\d])(\d{1,3})[.,](\d{1,2})(?!\d)/;
const priceTail = /(?:\s+\d{1,5}[.,]\d{2})+$/;
const hoursTail = /(?:\s+\d{1,3}[.,]\d{1,2})+$/;
const plainHoursTail = /(?:^|\s)(\d{1,3})[.,](\d{1,2})\s*(?:h|hr|hrs|hours?|t|timmar)?\s*$/i;

export interface SourceLine { text: string; cells: string[] }
export interface ParsedRepairSheet { pages: number; operations: RepairSheetOperation[]; skipped: number }
interface Row { code: string; description: string; hours: number | null }

function normalizeNumbers(text: string) {
  // `5,702850,00` is an hours cell and a price cell printed without a gap.
  return text.replace(/([.,]\d{1,2})(\d{3,}[.,]\d{2})/g, "$1 $2");
}

function hoursFromMatch(match: RegExpMatchArray): number | null {
  const hours = Number(match[1]) + Number(match[2]) / (match[2].length === 1 ? 10 : 100);
  return hours > 0 && hours <= 24 ? hours : null;
}

function findHours(text: string): number | null {
  const match = normalizeNumbers(text).match(hoursPattern);
  return match ? hoursFromMatch(match) : null;
}

function cleanDescription(text: string) {
  let out = text.replace(/\s+/g, " ").trim();
  if (typePattern.test(out)) out = out.replace(typePattern, " ").replace(/^[\s:.-]+/, "");
  out = out.replace(priceTail, "").replace(hoursTail, "");
  return out.replace(/[.,;:\s]+$/, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Read one printed line as a coded repair-time row, whichever way it was laid out. */
function readRow(cells: string[], text: string): Row | null {
  const cellIndex = cells.findIndex(cell => codePattern.test(cell.trim()));
  if (cellIndex >= 0) {
    const match = cells[cellIndex].trim().match(codePattern);
    if (!match) return null;
    const rest = match[2] || "";
    const hours = findHours(rest) ?? cells.slice(cellIndex + 1).map(findHours).find(hours => hours !== null) ?? null;
    return { code: match[1], description: cleanDescription(rest), hours };
  }
  const match = text.match(codePattern);
  if (!match) return null;
  return { code: match[1], description: cleanDescription(match[2] || ""), hours: findHours(match[2] || "") };
}

/** Read a plain `description hours` line, the shape pasted from the program. */
function readPlainRow(text: string): Row | null {
  const match = normalizeNumbers(text).trim().match(plainHoursTail);
  if (!match) return null;
  const hours = hoursFromMatch(match);
  if (hours === null) return null;
  const description = cleanDescription(text.slice(0, match.index).replace(/[.,;:\s]+$/, ""));
  if (description.length < 3 || !/[A-Za-z]{2}/.test(description)) return null;
  return { code: "", description, hours };
}

export function parseLines(lines: SourceLine[], options: { pages: number; allowPlain: boolean; emptyMessage: string; allowEmpty?: boolean }): ParsedRepairSheet {
  const operations: RepairSheetOperation[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  const push = (code: string, description: string, hours: number) => {
    const minutes = Math.round(hours * 60);
    if (minutes <= 0 || minutes > 1440) { skipped++; return; }
    const label = `${code} ${description}`.replace(/\s+/g, " ").trim();
    if (!label) { skipped++; return; }
    const key = `${code}|${description}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    operations.push({ code, operation: label, minutes });
  };

  let pending: { code: string; description: string } | null = null;
  for (const line of lines) {
    const cells = line.cells.length ? line.cells : [line.text];
    const row = readRow(cells, normalizeNumbers(line.text)) ?? (options.allowPlain ? readPlainRow(line.text) : null);

    if (row) {
      if (pending) { skipped++; pending = null; }
      if (row.hours !== null) push(row.code, row.description, row.hours);
      else if (row.code) pending = { code: row.code, description: row.description };
      continue;
    }

    if (!pending) continue;
    // A wrapped row: the hours sit on the next line, or a continuation of the description does.
    const hours = findHours(line.text);
    if (hours !== null) {
      push(pending.code, pending.description, hours);
      pending = null;
      continue;
    }
    if (/[A-Za-z]{3}/.test(line.text) && !/\d[.,]\d{2}/.test(line.text) && pending.description.length < 180) {
      pending.description = cleanDescription(`${pending.description} ${line.text}`);
    }
  }
  if (pending) skipped++;

  if (!operations.length && !options.allowEmpty) fail(400, options.emptyMessage);
  return { pages: options.pages, operations, skipped };
}

export function parseRepairSheet(buffer: Buffer): ParsedRepairSheet {
  const { lines, pages } = extractPdfText(buffer);
  if (!lines.length) {
    fail(400, "This PDF has no readable text layer. If it is a scan or a photo, enter the times manually or import a CSV instead.");
  }
  return parseLines(lines, {
    pages,
    allowPlain: false,
    emptyMessage: "No repair-time rows were found in this PDF. The sheet needs operation codes (for example A1.0100), descriptions and hours, or import a CSV instead.",
  });
}

export function parseRepairText(source: string, options: { allowEmpty?: boolean } = {}): ParsedRepairSheet {
  const rows = source
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  if (!rows.length) fail(400, "Paste the rows from your repair-time program first");
  const lines: SourceLine[] = rows.slice(0, 2000).map(text => ({
    text,
    cells: text.split(/\t| {2,}/).map(cell => cell.trim()).filter(Boolean),
  }));
  const parsed = parseLines(lines, {
    pages: 0,
    allowPlain: true,
    emptyMessage: "No repair-time rows were recognised. Copy rows that show a description and its hours, for example \"Engine & transmission complete 5.70\".",
    allowEmpty: options.allowEmpty,
  });
  return { ...parsed, skipped: parsed.skipped + Math.max(0, rows.length - lines.length) };
}
