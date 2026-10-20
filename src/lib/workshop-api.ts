import { useCallback, useEffect, useState } from "react";
import { emptyWorkspace, type Workspace } from "./workshop-types";
const sessionKey = "workshop-atlas-session";
export const sessionToken = () => sessionStorage.getItem(sessionKey);
export function setSession(token?: string) { if (token) sessionStorage.setItem(sessionKey, token); else sessionStorage.removeItem(sessionKey); }
export async function request(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  const token = sessionToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`/api/${path}`, { ...options, headers, cache: "no-store" });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { const error = await response.json(); message = error.statusMessage || error.message || message; } catch { /* Non-JSON server errors use the HTTP status. */ }
    if (response.status === 401) setSession();
    throw new Error(message);
  }
  return response;
}
export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await request(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return response.json();
}
export async function download(path: string, name: string) {
  const response = await request(path);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function fileUrl(path: string) {
  const response = await request(path);
  return URL.createObjectURL(await response.blob());
}
export async function uploadFile(path: string, formData: FormData): Promise<unknown> {
  const response = await request(path, { method: "POST", body: formData });
  return response.json();
}
export function useWorkspace() {
  const [data, setData] = useState<Workspace>(emptyWorkspace);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const result = await api<Workspace>("workspace");
      if (!result.user) setSession();
      setData(result); setError("");
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 30000);
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [refresh]);
  return { data, loading, error, refresh };
}
