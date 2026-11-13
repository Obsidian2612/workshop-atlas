export type Role = "admin" | "editor" | "viewer";
export type RecordKind = "procedure" | "note" | "service" | "part";
export type RepairTimeSource = "imported" | "provider" | "manual" | "gemini";
/** Operation codes used on repair-time sheets and workshop estimates. */
export const repairScopeCodes = ["R&I", "S&R", "C&A", "D&R", "Disconnect", "Partially remove"] as const;
export type RepairScopeCode = (typeof repairScopeCodes)[number];
/** One bundled line inside a repair time, e.g. "Camshaft/valve cover & gasket — R&I". */
export interface RepairTimeStep {
  label: string;
  /** R&I, S&R, C&A, D&R or any other code the sheet uses. */
  scope: string;
  minutes: number;
}
export interface RepairTimeEntry {
  operation: string;
  minutes: number;
  source: RepairTimeSource;
  /** R&I (remove and install), S&R (service and repair) and similar codes. */
  scope?: string;
  /** The other steps this operation's time includes. */
  includes?: RepairTimeStep[];
  /** The date the time is captured for. Future dates are listed as upcoming. */
  capturedAt?: string;
  notes?: string;
  combinedWith?: string[];
  timeSavingMinutes?: number;
}
export interface GeminiRepairRow { vin: string; operation: string; minutes: number; combinedWith?: string[]; timeSavingMinutes?: number }
export interface GroqRepairRow { operation: string; minutes: number; combinedWith?: string[]; timeSavingMinutes?: number }
export interface ManualRepairTimeRow { operation: string; minutes: number; scope?: string; includes?: RepairTimeStep[]; capturedAt?: string; notes?: string }
export interface GeminiTorqueRow extends TorqueSpec { vin: string }
export const torqueUnits = ["Nm", "lbf·ft", "lbf·in", "kgf·m"] as const;
export type TorqueUnit = (typeof torqueUnits)[number];
export interface TorqueSpec { fastener: string; stage: string; value: number; unit: TorqueUnit }
export interface TorqueSearchCandidate extends TorqueSpec { sourceTitle: string; sourceUrl: string; snippet: string; mentions: number }
export interface TorqueSearchSource { title: string; url: string; snippet: string }
export interface TorqueSearchResponse { query: string; provider: string; results: TorqueSearchSource[]; candidates: TorqueSearchCandidate[]; fetched: number; cached?: boolean }
export interface SpecSheetRow { label: string; value: string; note?: string }
export interface SpecSheetSection { title: string; rows: SpecSheetRow[] }
export interface SpecSheetIdentification { make: string; model: string; year: string; engine: string; engineModel: string; engineNumber: string; vin: string }
export interface VehicleSpecSheet {
  identification: SpecSheetIdentification; sections: SpecSheetSection[]; torques: TorqueSpec[];
  repairTimes: RepairTimeEntry[]; sources: TorqueSearchSource[];
}
export interface User { id: string; name: string; email: string; role: Role }
export interface Vehicle {
  id: string; make: string; model: string; year: string; engine: string;
  engineModel: string; engineNumber: string;
  registration: string; vin: string; customer: string; specifications: string;
  /** Read off the licence disk: the disk's own number, the colour and when it expires. */
  licenceNumber: string; colour: string; expiry: string;
  repairTimes?: RepairTimeEntry[]; repairTimesSource?: string; repairTimesUpdatedAt?: string;
  torqueSpecs?: TorqueSpec[]; torqueSpecsUpdatedAt?: string;
  createdAt: string; updatedAt: string; createdBy: string;
}
/** Details the vehicle editor can offer from a VIN; none of them are saved until the reader does. */
export type VinDetailField = "make" | "model" | "year" | "engine" | "engineModel";
export interface VinLookupResult {
  vin: string;
  fields: Partial<Record<VinDetailField, string>>;
  decoded: VinDetailField[];
  suggested: VinDetailField[];
  warnings: string[];
}
export interface WorkshopRecord {
  id: string; kind: RecordKind; title: string; vehicleId: string; category: string;
  content: string; date: string; mileage: string; repairTimeMinutes: number; createdAt: string; updatedAt: string; createdBy: string;
  /** Parts only: the number to order, who makes it and where it is bought. */
  partNumber?: string; partMake?: string; supplierId?: string;
}
/** A parts supplier: its website, plus an optional search URL for its own catalogue. */
export interface Supplier {
  id: string; name: string; website: string;
  /** A search address on the supplier's site; `{query}` is replaced with the search terms. */
  searchUrl: string; createdAt: string; createdBy: string;
}
export interface Attachment {
  id: string; recordId: string; name: string; type: string; size: number; createdAt: string; createdBy: string;
}
export interface Activity { id: string; text: string; at: string; actor: string }
export interface RepairTimePdf { id: string; vehicleId: string | null; name: string; size: number; createdAt: string; createdBy: string }
export interface RepairSheetOperation { code: string; operation: string; minutes: number }
export interface VehicleIdentification { make: string; model: string; year: string; engine: string; capacity: string; torque: string }
export interface Workspace {
  setupRequired: boolean; user: User | null; name: string; vmUrl: string;
  vehicles: Vehicle[]; records: WorkshopRecord[]; attachments: Attachment[]; activity: Activity[]; users: User[];
  suppliers: Supplier[];
  repairTimeMinutes: number;
  // Uploaded repair-time sheets (PDF prints). Only administrators receive them.
  repairTimePdfs?: RepairTimePdf[];
}
export type Section = "overview" | "vehicles" | "procedures" | "notes" | "history" | "parts" | "attachments" | "legacy" | "settings";
export const sectionTitles: Record<Section, string> = {
  overview: "Workshop overview", vehicles: "Vehicle library", procedures: "Service procedures",
  notes: "Repair notes", history: "Service history", parts: "Parts & suppliers",
  attachments: "Documents & photos",
  legacy: "Autodata connection", settings: "Workspace settings",
};
export const emptyWorkspace: Workspace = {
  setupRequired: false, user: null, name: "My workshop", vmUrl: "",
  vehicles: [], records: [], attachments: [], activity: [], users: [], suppliers: [],
  repairTimeMinutes: 0
};
