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

export function parseLines(lines: SourceLine[], options: { pages: number; allowPlain: boolean; emptyMessage: string; allowEmpty?: boolean }): ParsedRepairSheet {
  const operations: RepairSheetOperation[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  const addOperation = (code: string, description: string, hours: number | null): void => {
    const key = `${code}|${description.trim()}`;
    if (seen.has(key)) return;
    seen.add(key);
    operations.push({ code, operation: description, minutes: hours ?? 0 });
  };

  let pending: { code: string; description: string } | null = null;
  for (const line of lines) {
    const cells = line.cells.length ? line.cells : [line.text];
    const row = readRow(cells, normalizeNumbers(line.text)) ?? (options.allowPlain ? readPlainRow(line.text) : null);

    if (row) {
      if (pending) skipped++;
      addOperation(row.code, row.description, row.hours);
      pending = null;
    } else if (!pending) {
      pending = { code: "", description: "" };
    }

    if (pending) {
      const text = normalizeNumbers(line.text).trim();
      if (!/[A-Za-z]{3}/.test(text)) continue;
      const hoursText = extractHours(text);
      if (!hoursText) continue;
      pending.hours = parseFloat(hoursText);
      if (isNaN(pending.hours)) continue;
      addOperation(pending.code, pending.description, pending.hours);
      pending = null;
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
  const lines = rows.slice(0, 2000).map(text => ({
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
