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

// temporary
