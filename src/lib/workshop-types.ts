export type Role = "admin" | "editor" | "viewer";
export type RecordKind = "procedure" | "note" | "service";
export type RepairTimeSource = "imported" | "provider" | "manual" | "gemini";
export interface RepairTimeEntry { operation: string; minutes: number; source: RepairTimeSource }
export interface GeminiRepairRow { vin: string; operation: string; minutes: number }
export interface GeminiTorqueRow extends TorqueSpec { vin: string }
export const torqueUnits = ["Nm", "lbf·ft", "lbf·in", "kgf·m"] as const;
export type TorqueUnit = (typeof torqueUnits)[number];
export interface TorqueSpec { fastener: string; stage: string; value: number; unit: TorqueUnit }
export interface TorqueSearchCandidate extends TorqueSpec { sourceTitle: string; sourceUrl: string; snippet: string; mentions: number }
export interface TorqueSearchSource { title: string; url: string; snippet: string }
export interface TorqueSearchResponse { query: string; provider: string; results: TorqueSearchSource[]; candidates: TorqueSearchCandidate[]; fetched: number; cached?: boolean }
export interface User { id: string; name: string; email: string; role: Role }
export interface Vehicle {
  id: string; make: string; model: string; year: string; engine: string;
  engineModel: string; engineNumber: string;
  registration: string; vin: string; customer: string; specifications: string;
  repairTimes?: RepairTimeEntry[]; repairTimesSource?: string; repairTimesUpdatedAt?: string;
  torqueSpecs?: TorqueSpec[]; torqueSpecsUpdatedAt?: string;
  createdAt: string; updatedAt: string; createdBy: string;
}
export interface WorkshopRecord {
  id: string; kind: RecordKind; title: string; vehicleId: string; category: string;
  content: string; date: string; mileage: string; repairTimeMinutes: number; createdAt: string; updatedAt: string; createdBy: string;
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
  repairTimeMinutes: number;
  // Uploaded repair-time sheets (PDF prints). Only administrators receive them.
  repairTimePdfs?: RepairTimePdf[];
}
export type Section = "overview" | "vehicles" | "procedures" | "notes" | "history" | "attachments" | "legacy" | "settings";
export const sectionTitles: Record<Section, string> = {
  overview: "Workshop overview", vehicles: "Vehicle library", procedures: "Service procedures",
  notes: "Repair notes", history: "Service history", attachments: "Documents & photos",
  legacy: "Autodata connection", settings: "Workspace settings",
};
export const emptyWorkspace: Workspace = {
  setupRequired: false, user: null, name: "My workshop", vmUrl: "",
  vehicles: [], records: [], attachments: [], activity: [], users: [],
  repairTimeMinutes: 0
};
