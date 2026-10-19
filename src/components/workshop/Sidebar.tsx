import { NavLink } from "react-router-dom";
import { LayoutDashboard, CarFront, BookOpen, StickyNote, History, FolderOpen, Cable, Settings2, ChevronDown, ArrowUpRight, ShieldCheck, X, Wrench } from "lucide-react";
import type { Workspace } from "@/lib/workshop-types";
import { cn } from "@/lib/utils";
export const navigation = [
  { path: "/", title: "Overview", icon: LayoutDashboard },
  { path: "/vehicles", title: "Vehicle library", icon: CarFront },
  { path: "/procedures", title: "Service procedures", icon: BookOpen },
  { path: "/notes", title: "Repair notes", icon: StickyNote },
  { path: "/history", title: "Service history", icon: History },
  { path: "/attachments", title: "Documents & photos", icon: FolderOpen },
];
export default function Sidebar({ data, open, close, onAuth }: { data: Workspace; open: boolean; close: () => void; onAuth: () => void }) {
  return <>
    {open && <button aria-label="Close navigation" onClick={close} className="fixed inset-0 z-40 bg-foreground/30 backdrop-blur-sm lg:hidden" />}
    <aside className={cn("fixed inset-y-0 left-0 z-40 flex w-[244px] flex-col border-r border-border bg-white px-4 transition-transform lg:translate-x-0", open ? "translate-x-0" : "-translate-x-full")}>
      <NavLink to="/" onClick={close} className="flex items-center gap-2.5 px-2 pb-8 pt-8"><img src="/assets/atlas-mark.png" alt="" className="h-10 w-10 rounded-xl object-cover" /><div><span className="font-heading text-[17px] font-extrabold tracking-[-0.6px]">Workshop<span className="text-primary">Atlas</span></span><span className="mt-0.5 block text-[9px] font-semibold uppercase tracking-[2px] text-muted-foreground">Knowledge. Connected.</span></div></NavLink>
      <button aria-label="Close menu" onClick={close} className="absolute right-2 top-2 rounded-lg p-2 text-muted-foreground lg:hidden"><X size={16} /></button>
      <NavLink to="/settings" onClick={close} className="mb-7 flex items-center gap-3 rounded-xl border border-border bg-background p-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-primary shadow-sm"><Wrench size={16} /></span><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{data.name}</p><p className="mt-1 text-[10px] text-muted-foreground">Local workspace</p></div><ChevronDown size={13} className="text-muted-foreground" /></NavLink>
      <p className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[1.8px] text-muted-foreground">Workspace</p>
      <nav aria-label="Main navigation" className="space-y-1">{navigation.map(item => <NavLink key={item.path} to={item.path} end={item.path === "/"} onClick={close} className={({ isActive }) => cn("group flex items-center gap-3 rounded-lg px-3 py-3 text-[13px] font-medium transition-colors", isActive ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-background hover:text-foreground")}><item.icon size={18} strokeWidth={1.7} />{item.title}</NavLink>)}</nav>
      <p className="mb-3 mt-8 px-3 text-[10px] font-semibold uppercase tracking-[1.8px] text-muted-foreground">Manage</p>
      <nav className="space-y-1" aria-label="Workspace management">{[{ path: "/legacy", title: "Autodata connection", icon: Cable }, { path: "/settings", title: "Settings & members", icon: Settings2 }].map(item => <NavLink key={item.path} to={item.path} onClick={close} className={({ isActive }) => cn("flex items-center gap-3 rounded-lg px-3 py-3 text-[13px] font-medium", isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-background hover:text-foreground")}><item.icon size={18} strokeWidth={1.7} />{item.title}{item.path === "/legacy" && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-500" />}</NavLink>)}</nav>
      <div className="mt-auto pt-8"><div className="rounded-xl border border-primary/10 bg-[#f0f7f4] p-4"><span className="mb-2 flex items-center gap-2 text-xs font-bold text-primary"><ShieldCheck size={16} />Your data, your workshop</span><p className="text-[11px] leading-5 text-muted-foreground">Built for your local network.<br />No hosted service required.</p><NavLink to="/settings" onClick={close} className="mt-3 flex items-center gap-1 text-[11px] font-semibold text-primary">Workspace details <ArrowUpRight size={12} /></NavLink></div>
      <button onClick={() => { close(); onAuth(); }} className="my-4 flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left hover:bg-background"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#e7efeb] text-xs font-bold text-primary">{data.user ? data.user.name.split(" ").map(s => s[0]).slice(0, 2).join("") : "WA"}</span><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{data.user?.name || "Your workshop account"}</p><p className="mt-0.5 text-[10px] capitalize text-muted-foreground">{data.user ? `${data.user.role} · Account` : data.setupRequired ? "Set up your workspace" : "Sign in to get started"}</p></div><ChevronDown size={13} className="text-muted-foreground" /></button></div>
    </aside>
  </>;
}
