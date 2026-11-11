export interface LicenceDiskDetails {
  vin: string;
  engineNumber: string;
  registration: string;
  make: string;
  model: string;
  licenceNumber: string;
  colour: string;
  expiry: string;
}

// Makes whose printed form is an acronym rather than a word.
const acronyms = new Set(["BMW", "GWM", "MAN", "MG", "VW", "LDV", "JMC", "UD", "GMC"]);

function titleCase(value: string) {
  const upper = value.toUpperCase();
  if (acronyms.has(upper)) return upper;
  return upper.toLowerCase().replace(/(^|[\s\-/])([a-z])/g, (_match, separator: string, letter: string) => separator + letter.toUpperCase());
}

/**
 * Read a vehicle licence disk barcode.
 *
 * The PDF417 payload on a South African licence disk is %-separated, with each
 * fact at a fixed position: 5 licence number, 6 register number, 7 description,
 * 8 make, 10 colour, 11 VIN, 12 engine number, 13 expiry date. Positions vary
 * between issuers, so anything short or missing simply comes back empty rather
 * than guessing another field's value.
 */
export function parseLicenceDisk(payload: string): LicenceDiskDetails {
  const parts = payload.replace(/^%+|%+$/g, "").split("%").map(part => part.trim());
  const at = (index: number) => (parts[index] || "").replace(/\s+/g, " ");
  const compact = (value: string) => value.replace(/[\s-]+/g, "").toUpperCase();
  return {
    vin: compact(at(11)),
    engineNumber: compact(at(12)),
    registration: compact(at(6)),
    make: titleCase(at(8)),
    model: titleCase(at(7)),
    licenceNumber: at(5),
    colour: titleCase(at(10)),
    expiry: at(13),
  };
}

/** True when the payload yielded anything worth putting on a vehicle. */
export function licenceDiskHasDetails(details: LicenceDiskDetails) {
  return Boolean(details.vin || details.engineNumber || details.registration || details.make || details.model);
}
