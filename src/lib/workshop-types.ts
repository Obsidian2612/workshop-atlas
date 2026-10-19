export type Role = "admin" | "editor" | "viewer";
export type RecordKind = "procedure" | "note" | "service";
export type RepairTimeSource = "imported" | "provider" | "manual";
export interface RepairTimeEntry { operation: string; minutes: number; source: RepairTimeSource }
export interface User { id: string; name: string; email: string; role: Role }
export interface Vehicle {
  id: string; make: string; model: string; year: string; engine: string;
  registration: string; vin: string; customer: string; specifications: string;
  repairTimes?: RepairTimeEntry[]; repairTimesSource?: string; repairTimesUpdatedAt?: string;
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
export interface Workspace {
  setupRequired: boolean; user: User | null; name: string; vmUrl: string;
  vehicles: Vehicle[]; records: WorkshopRecord[]; attachments: Attachment[];
  activity: Activity[]; users: User[];
}
export type Section = "overview" | "vehicles" | "procedures" | "notes" | "history" | "attachments" | "legacy" | "settings";
export const sectionTitles: Record<Section, string> = {
  overview: "Workshop overview", vehicles: "Vehicle library", procedures: "Service procedures",
  notes: "Repair notes", history: "Service history", attachments: "Documents & photos",
  legacy: "Autodata connection", settings: "Workspace settings",
};
export const emptyWorkspace: Workspace = {
  setupRequired: false, user: null, name: "My workshop", vmUrl: "", vehicles: [],
  records: [], attachments: [], activity: [], users: [],
  repairTimeMinutes: 0
};
