import type { VehicleIdentification } from "../../src/lib/workshop-types";

/*
 * Vehicle identification screens in the repair-time program read as a header
 * row followed by the selected vehicle (`Year | Manufacturers | Model range |
 * Engine`) and, below it, an engine panel (`Engine code | kW | Tuned for |
 * Year`). Copies also arrive as labelled lines (`Make: Alfa Romeo`) or as a
 * single row of four cells. This parser is deliberately conservative: it only
 * fills a field when the value looks usable, and the app shows every detected
 * value in editable inputs before saving anything.
 */

type Field = keyof VehicleIdentification;

const labels: Record<string, Field> = {
  make: "make",
  manufacturer: "make",
  manufacturers: "make",
  marque: "make",
  model: "model",
  "model range": "model",
  "model name": "model",
  year: "year",
  "model year": "year",
  engine: "engine",
  "engine code": "engine",
  "engine type": "engine",
  variant: "engine",
  capacity: "capacity",
  "engine capacity": "capacity",
  "engine displacement": "capacity",
  displacement: "capacity",
  torque: "torque",
  "engine torque": "torque",
};

function clean(value: string) {
  return value.replace(/\s+/g, " ").replace(/^[\s:;.,\\-–—|]+/, "").trim();
}

function labelKey(value: string): Field | null {
  const key = value.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  return labels[key] ?? null;
}

function splitCells(line: string) {
  return line.split(/\t|\s*\|\s*| {2,}/).map(cell => cell.trim()).filter(Boolean);
}

function usable(field: Field, raw: string): string | null {
  const value = clean(raw);
  if (!value || value.length > 120) return null;
  if (/^(all|any|none|n\/a|not recorded|not specified)$/i.test(value)) return null;
  if (labelKey(value)) return null;
  if (field === "year") {
    const match = value.match(/\b(19|20)\d{2}\b/);
    return match ? match[0] : null;
  }
  if (field === "make") return /[A-Za-z]{2}/.test(value) && value.length <= 40 ? value : null;
  if (field === "model") return /[A-Za-z0-9]/.test(value) && value.length <= 60 ? value : null;
  if (field === "capacity") return usableCapacity(value);
  if (field === "torque") return usableTorque(value);
  if (field === "engine") return usableEngine(value);
  if (/kw|din/i.test(value) || value.length > 40) return null;
  return value;
}

function usableEngine(raw: string): string | null {
  const value = clean(raw);
  if (!value || value.length > 60) return null;
  if (/^(all|any|none|n\/a|not recorded|not specified)$/i.test(value)) return null;
  if (labelKey(value)) return null;
  if (/hp|\bblbf?\b|\bk\s*\d/i.test(value) && /\d/.test(value)) return null;
  if (/kw|din/i.test(value)) return null;
  return value;
}

function usableCapacity(value: string): string | null {
  const v = clean(value);
  if (!v || v.length > 40) return null;
  if (/^(all|any|none|n\/a|not recorded|not specified)$/i.test(v)) return null;
  if (labelKey(v)) return null;
  if (!/\d/.test(v)) return null;
  return v;
}

function usableTorque(value: string): string | null {
  const v = clean(value);
  if (!v || v.length > 60) return null;
  if (/^(all|any|none|n\/a|not recorded|not specified)$/i.test(v)) return null;
  if (labelKey(v)) return null;
  if (!/\d/.test(v)) return null;
  if (/[A-Za-z]{2,}/.test(v) && /\d/.test(v) && !/\d{1,3}\s*[NmN\.m]/i.test(v)) return null;
  return v;
}

export function parseVehicleIdentification(source: string): VehicleIdentification | null {
  const lines = source.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").split("\n").map(line => line.trim()).filter(Boolean);
  const found: Partial<VehicleIdentification> = {};

  const set = (field: Field, raw: string, override = false) => {
    if (found[field] && !override) return;
    const value = usable(field, raw);
    if (value) found[field] = value;
  };

  const setCapacity = (raw: string, override = false) => {
    if (found.capacity && !override) return;
    const value = usableCapacity(raw);
    if (value) found.capacity = value;
  };

  const setTorque = (raw: string, override = false) => {
    if (found.torque && !override) return;
    const value = usableTorque(raw);
    if (value) found.torque = value;
  };

  const setEngine = (raw: string, override = false) => {
    if (found.engine && !override) return;
    const value = usableEngine(raw);
    if (value) found.engine = value;
  };

  // 1. Labelled lines, the least ambiguous form.
  for (const line of lines) {
    const cells = splitCells(line);
    if (cells.length >= 2) {
      const field = labelKey(cells[0]);
      if (field) {
        // A header row carries several labels; it is not a value.
        if (field === "capacity") { setCapacity(cells.slice(1).join(" "), false); continue; }
        if (field === "torque") { setTorque(cells.slice(1).join(" "), false); continue; }
        if (cells.slice(1).every(cell => !labelKey(cell))) set(field, cells.slice(1).join(" "));
        continue;
      }
    }
    const match = line.match(/^([A-Za-z][A-Za-z /.-]{1,30}?)\s*[:-]\s*(.+)$/);
    if (!match) continue;
    const field = labelKey(match[1]);
    if (field === "capacity") { setCapacity(match[2], false); continue; }
    if (field === "torque") { setTorque(match[2], false); continue; }
    if (field) set(field, match[2]);
  }

  // 2. Column tables: a header row and the row beneath it.
  const tables: { keys: (Field | null)[]; row: string[] }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const keys = splitCells(lines[index]).map(labelKey);
    if (keys.filter(Boolean).length < 2) continue;
    for (let next = index + 1; next < Math.min(index + 4, lines.length); next++) {
      const row = splitCells(lines[next]);
      if (row.length < 2) continue;
      if (row.filter(cell => labelKey(cell)).length >= 2) continue;
      tables.push({ keys, row });
      break;
    }
  }

  const applyTable = (table: { keys: (Field | null)[]; row: string[] }, override: boolean) => {
    table.keys.forEach((field, index) => {
      if (!field) return;
      if (field === "capacity") setCapacity(table.row[index] ?? "", override);
      else if (field === "torque") setTorque(table.row[index] ?? "", override);
      else if (field === "engine") setEngine(table.row[index] ?? "", override);
      else set(field, table.row[index] ?? "", override);
    });
  };

  const enginePanel = (table: { keys: (Field | null)[] }) => table.keys.includes("engine") && table.keys.includes("year");
  for (const table of tables.filter(item => !enginePanel(item))) applyTable(table, false);
  for (const table of tables.filter(enginePanel)) applyTable(table, true);

  // 3. A headerless copied row: year, make, model, engine.
  if (!Object.keys(found).length) {
    for (const line of lines) {
      const cells = splitCells(line);
      if (cells.length !== 4) continue;
      const year = usable("year", cells[0]);
      const make = usable("make", cells[1]);
      const model = usable("model", cells[2]);
      const engine = usableEngine(cells[3]);
      if (year && make && model && engine) return { make, model, year, engine, capacity: "", torque: "" };
      const capacity = usableCapacity(cells[2]);
      const torque = usableTorque(cells[3]);
      if (capacity && torque) return { make, model, year, engine: "", capacity, torque };
      const altEngine = usableEngine(cells[2]);
      const altCapacity = usableCapacity(cells[3]);
      if (altEngine && altCapacity) return { make, model, year, engine: altEngine, capacity: altCapacity, torque: "" };
      const capacity2 = usableCapacity(cells[2]);
      const torque2 = usableTorque(cells[3]);
      if (year && make && model && capacity2 && torque2) return { make, model, year, engine: "", capacity: capacity2, torque: torque2 };
    }
  }

  const identification: VehicleIdentification = {
    make: found.make ?? "",
    model: found.model ?? "",
    year: found.year ?? "",
    engine: found.engine ?? "",
    capacity: found.capacity ?? "",
    torque: found.torque ?? "",
  };

  const engineFromRow = usableEngine(found.engine);
  if (engineFromRow) identification.engine = engineFromRow;
  const capacityFromRow = usableCapacity(found.capacity);
  if (capacityFromRow) identification.capacity = capacityFromRow;
  const torqueFromRow = usableTorque(found.torque);
  if (torqueFromRow) identification.torque = torqueFromRow;

  const values = Object.values(identification).filter(Boolean);
  if (values.length < 2) return null;
  if (!identification.make && !identification.model && !identification.engine) return null;
  return identification;
}
