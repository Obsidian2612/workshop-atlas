import { inflateSync } from "node:zlib";
import { fail } from "./store";

/*
 * Minimal, dependency-free PDF text reader for printed repair-time sheets.
 *
 * It walks FlateDecode content streams, tracks the text matrix (Tm/Td/TD/T*) so
 * runs can be grouped into visual lines and cells, and decodes simple-font
 * strings as WinAnsi. That covers sheets printed from parts catalogues and
 * terminal software (Ghostscript/PScript5 and the Windows print driver), which
 * is what repair-time PDFs normally are. Scanned pages, CID fonts without a
 * text layer and exotic filters are reported as unreadable rather than guessed.
 */

export interface PdfLine { text: string; cells: string[] }
export interface PdfText { pages: number; lines: PdfLine[]; images: boolean }

const maxStreams = 200;
const maxStreamBytes = 4_000_000;
const maxLines = 5000;

type Operand =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "name"; value: string }
  | { kind: "array"; value: Operand[] }
  | { kind: "arrayStart" };

interface Run { text: string; x: number; y: number; size: number }

const whitespace = /[\s\0]/;
const delimiter = /[()<>[\]{}/%]/;

function decodeBytes(bytes: number[]): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(new Uint8Array(bytes.slice(2)));
  }
  try { return new TextDecoder("windows-1252").decode(new Uint8Array(bytes)); }
  catch { return bytes.map(byte => String.fromCharCode(byte)).join(""); }
}

function decodeHex(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const bytes: number[] = [];
  for (let index = 0; index + 1 < clean.length; index += 2) bytes.push(parseInt(clean.slice(index, index + 2), 16));
  return decodeBytes(bytes);
}

function readLiteral(source: string, start: number): { value: string; next: number } {
  const bytes: number[] = [];
  let index = start + 1;
  let depth = 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1];
      index += 2;
      if (next === "n") bytes.push(10);
      else if (next === "r") bytes.push(13);
      else if (next === "t") bytes.push(9);
      else if (next === "b") bytes.push(8);
      else if (next === "f") bytes.push(12);
      else if (next === "\n") { /* escaped newline */ }
      else if (next === "\r") { if (source[index] === "\n") index++; }
      else if (next >= "0" && next <= "7") {
        let octal = next;
        while (octal.length < 3 && source[index] >= "0" && source[index] <= "7") octal += source[index++];
        bytes.push(parseInt(octal, 8) & 0xff);
      } else bytes.push(next.charCodeAt(0) & 0xff);
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") { depth--; if (!depth) return { value: decodeBytes(bytes), next: index + 1 }; }
    bytes.push(char.charCodeAt(0) & 0xff);
    index++;
  }
  return { value: decodeBytes(bytes), next: source.length };
}

function decodeRunText(text: string) {
  let out = ""; for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c >= 0x20 && c !== 0x7f) out += text[i]; } return out.trim();
}

function extractRuns(content: string): Run[] {
  const runs: Run[] = [];
  let index = 0;
  let x = 0;
  let y = 0;
  let leading = 0;
  let size = 12;
  let operands: Operand[] = [];

  const emit = (text: string) => {
    const clean = decodeRunText(text);
    if (clean) runs.push({ text: clean, x, y, size });
  };
  const numbers = () => operands.filter((operand): operand is { kind: "number"; value: number } => operand.kind === "number").map(operand => operand.value);
  const strings = () => operands.filter((operand): operand is { kind: "string"; value: string } => operand.kind === "string").map(operand => operand.value);

  while (index < content.length) {
    const char = content[index];
    if (char === "%") {
      while (index < content.length && content[index] !== "\n" && content[index] !== "\r") index++;
      continue;
    }
    if (char === "(") {
      const literal = readLiteral(content, index);
      operands.push({ kind: "string", value: literal.value });
      index = literal.next;
      continue;
    }
    if (char === "<") {
      if (content[index + 1] === "<") { index += 2; continue; }
      const end = content.indexOf(">", index);
      if (end < 0) break;
      operands.push({ kind: "string", value: decodeHex(content.slice(index + 1, end)) });
      index = end + 1;
      continue;
    }
    if (char === ">") { index++; continue; }
    if (char === "[") { operands.push({ kind: "arrayStart" }); index++; continue; }
    if (char === "]") {
      const items: Operand[] = [];
      while (operands.length) {
        const operand = operands.pop() as Operand;
        if (operand.kind === "arrayStart") break;
        items.unshift(operand);
      }
      operands.push({ kind: "array", value: items });
      index++;
      continue;
    }
    if (char === "/") {
      let end = index + 1;
      while (end < content.length && !whitespace.test(content[end]) && !delimiter.test(content[end])) end++;
      operands.push({ kind: "name", value: content.slice(index + 1, end) });
      index = end;
      continue;
    }
    if (/[+-.\d]/.test(char) && (char !== "-" && char !== "+" && char !== "." || /[.\d]/.test(content[index + 1] || ""))) {
      let end = index + 1;
      while (end < content.length && /[-+.\d]/.test(content[end])) end++;
      const value = Number(content.slice(index, end));
      if (Number.isFinite(value)) operands.push({ kind: "number", value });
      index = end;
      continue;
    }
    if (whitespace.test(char)) { index++; continue; }
    let end = index;
    while (end < content.length && !whitespace.test(content[end]) && !delimiter.test(content[end])) end++;
    const operator = content.slice(index, end) || content[index];
    index = end > index ? end : index + 1;

    const values = numbers();
    switch (operator) {
      case "BT": x = 0; y = 0; break;
      case "Tm": if (values.length >= 6) { x = values[4]; y = values[5]; } break;
      case "Td": if (values.length >= 2) { x += values[0]; y += values[1]; } break;
      case "TD": if (values.length >= 2) { x += values[0]; y += values[1]; leading = -values[1]; } break;
      case "TL": if (values.length >= 1) leading = values[0]; break;
      case "T*": y -= leading; break;
      case "Tf": if (values.length >= 2 && values[1] > 0) size = values[1]; break;
      case "Tj": if (strings().length) emit(strings()[strings().length - 1]); break;
      case "'": y -= leading; if (strings().length) emit(strings()[0]); break;
      case '"': y -= leading; if (strings().length) emit(strings()[strings().length - 1]); break;
      case "TJ": {
        const array = operands.find(operand => operand.kind === "array");
        if (array && array.kind === "array") {
          let text = "";
          for (const item of array.value) {
            if (item.kind === "string") text += item.value;
            else if (item.kind === "number" && item.value <= -200) text += " ";
          }
          emit(text);
        }
        break;
      }
      default: break;
    }
    operands = [];
  }
  return runs;
}

function printableRatio(text: string) {
  let printable = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) printable++;
  }
  return text.length ? printable / text.length : 0;
}

function contentStreams(buffer: Buffer): string[] {
  const raw = buffer.toString("latin1");
  const streams: string[] = [];
  const regex = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) && streams.length < maxStreams) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    regex.lastIndex = end + 9;
    const slice = Buffer.from(raw.slice(start, end), "latin1");
    if (slice.length > maxStreamBytes) continue;
    let decoded: string | null = null;
    try { decoded = inflateSync(slice).toString("latin1"); } catch { decoded = null; }
    if (!decoded) {
      const plain = slice.toString("latin1");
      if (/\bBT\b/.test(plain) && /\bT[Jj]\b/.test(plain)) decoded = plain;
    }
    if (decoded && decoded.length < maxStreamBytes && /\bBT\b/.test(decoded) && /\bT[Jj]\b/.test(decoded) && printableRatio(decoded) > 0.6) {
      streams.push(decoded);
    }
  }
  return streams;
}

function estimateWidth(text: string, size: number) {
  return text.length * size * 0.5;
}

function runsToLines(runs: Run[]): PdfLine[] {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfLine[] = [];
  let group: Run[] = [];
  let lineY = Number.NaN;

  const flush = () => {
    if (!group.length) return;
    const ordered = [...group].sort((a, b) => a.x - b.x);
    const cells: string[] = [];
    let cell = "";
    let previousEnd = Number.NaN;
    for (const run of ordered) {
      const gap = Number.isNaN(previousEnd) ? Infinity : run.x - previousEnd;
      if (gap > 4) {
        if (cell.trim()) cells.push(cell.trim());
        cell = run.text;
      } else {
        cell = cell ? `${cell} ${run.text}` : run.text;
      }
      previousEnd = run.x + estimateWidth(run.text, run.size);
    }
    if (cell.trim()) cells.push(cell.trim());
    if (cells.length) lines.push({ text: cells.join("  "), cells });
    group = [];
  };

  for (const run of sorted) {
    if (Number.isNaN(lineY) || Math.abs(run.y - lineY) > 2.5) { flush(); lineY = run.y; }
    group.push(run);
  }
  flush();
  return lines;
}

export function extractPdfText(buffer: Buffer): PdfText {
  const raw = buffer.toString("latin1");
  if (!raw.startsWith("%PDF")) fail(400, "That file is not a PDF");
  const streams = contentStreams(buffer);
  const pages = Math.max(1, (raw.match(/\/Type\s*\/Page(?![sA-Za-z])/g) || []).length);
  const lines: PdfLine[] = [];
  for (const stream of streams) {
    const runs = extractRuns(stream);
    if (!runs.length) continue;
    for (const line of runsToLines(runs)) {
      if (lines.length >= maxLines) break;
      if (line.text.trim()) lines.push(line);
    }
    if (lines.length >= maxLines) break;
  }
  return { pages, lines, images: /\/Subtype\s*\/Image/.test(raw) };
}
