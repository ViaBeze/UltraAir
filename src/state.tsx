import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { clearBrowserPush } from './pushClient';
export type User = { id: string; role: 'patient' | 'doctor'; login: string; name: string };
export type PlantKind = 'cornflower' | 'cactus' | 'daisy' | 'monstera';
export type Garden = { plant: PlantKind; chosen: boolean; growth: number; stage: number };
export type RewardResult = { ok: boolean; earnedDrops: number };
export type AlcoholFields = { alcohol: 'yes' | 'no' | 'private' | null; alcoholDrink: string; alcoholVolume: number | null; alcoholStrength: number | null; alcoholTime: string | null; alcoholNote: string };
export type Patient = { id: string; name: string; age: string; birth: string; phone: string; email: string; department: string; note?: string; diagnosis?: string; treatment?: string; allergy?: string; medications?: string[]; conditions?: string; transfer?: string; doctorName: string; login: string; activated: boolean; version: number; created: string; updated: string; garden: Garden };
export type Entry = Partial<AlcoholFields> & { id: string; patientId: string; date: string; score: number; sleep: number; energy: number; tags: string[]; comment: string; mediaId?: string; created: string; updated: string };
export type Message = { id: string; author: 'patient' | 'doctor'; authorName: string; text: string; created: string; readAt: string | null; patientId: string; sosId: string | null; mediaId: string | null };
export type Medication = { name: string; dose: string; instructions: string; times: string[]; start: string; end: string | null };
export type Prescription = Medication & { id: string; patientId: string; visitId: string; active: boolean };
export type Visit = { id: string; patientId: string; scheduled: string; status: 'scheduled' | 'draft' | 'confirmed' | 'cancelled'; version: number; title: string; notes?: string; observation?: string; diagnosis?: string; plan?: string; prescriptions?: Medication[]; confirmed: string | null; created: string; updated: string };
export type Sos = { id: string; patientId: string; status: 'sent' | 'delivered' | 'answered' | 'closed'; severity: number; danger: '' | 'yes' | 'unsure' | 'no'; detail: string; medication: string; created: string; delivered: string | null; answered: string | null; closed: string | null };
export type Settings = { source: string; diary: string; enabled: boolean; timezone: string };
export type AppState = { user: User | null; patients: Patient[]; entries: Entry[]; messages: Message[]; visits: Visit[]; prescriptions: Prescription[]; marks: { id: string; prescriptionId: string; patientId: string; date: string; time: string; status: string; note: string; updated: string }[]; sosEvents: Sos[]; notifications: { id: string; title: string; link: string; created: string; readAt: string | null }[]; settings: Settings };
const empty: AppState = { user: null, patients: [], entries: [], messages: [], visits: [], prescriptions: [], marks: [], sosEvents: [], notifications: [], settings: { source: 'РЛС', diary: '19:00', enabled: true, timezone: 'Europe/Moscow' } };
export class ApiError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } }
export async function api<T = { ok: boolean }>(path: string, method = 'GET', body?: unknown): Promise<T> {
 let response: Response;
 try { response = await fetch('/api' + path, { method, credentials: 'same-origin', cache: 'no-store', headers: { 'X-Ryadom': '1', ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), signal: AbortSignal.timeout(body instanceof FormData ? 120000 : 20000) }); }
 catch { throw new ApiError('Нет связи с сервером. Проверьте интернет и повторите действие.', 0); }
 const result = await response.json().catch(() => null);
 if (!response.ok) { if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('ryadom-session-expired')); throw new ApiError(typeof result?.detail === 'string' ? result.detail : 'Не удалось выполнить запрос. Попробуйте ещё раз.', response.status); }
 if (!result) throw new ApiError('Сервер вернул неожиданный ответ', 502); return result as T;
}
type ContextValue = { state: AppState; user: User | null; loading: boolean; online: boolean; error: string; refresh: () => Promise<void>; mutate: <T = { ok: boolean }>(path: string, method?: string, body?: unknown) => Promise<T>; logout: () => Promise<void>; toast: (text: string) => void };
const Context = createContext<ContextValue>(null!);
export function AppProvider({ children }: { children: ReactNode }) {
 const [state, setState] = useState(empty); const [loading, setLoading] = useState(true); const [online, setOnline] = useState(true); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
 const sequence = useRef(0); const toastTimer = useRef<number | undefined>(undefined);
 const refresh = useCallback(async () => { const seq = ++sequence.current; try { const data = await api<AppState>('/state'); if (seq === sequence.current) { setState(data); setOnline(true); setError(''); } } catch (e) { if (seq !== sequence.current) return; if (e instanceof ApiError && e.status === 401) { setState(empty); setError(''); } else { setOnline(false); setError(e instanceof Error ? e.message : 'Ошибка подключения'); } } finally { if (seq === sequence.current) setLoading(false); } }, []);
 useEffect(() => { try { localStorage.removeItem('ryadom-ui-demo-v1'); sessionStorage.removeItem('ryadom-diary-draft'); } catch { /* Storage can be disabled; accounts use HttpOnly cookies. */ } void refresh(); const expired = () => { ++sequence.current; setState(empty); setLoading(false); }; window.addEventListener('ryadom-session-expired', expired); return () => { ++sequence.current; window.removeEventListener('ryadom-session-expired', expired); }; }, [refresh]);
 useEffect(() => { if (!state.user) return; let stopped = false; let timer: number; async function poll() { await refresh(); if (!stopped) timer = window.setTimeout(poll, document.hidden ? 15000 : 2500); } timer = window.setTimeout(poll, 2500); const focus = () => { void refresh(); }; window.addEventListener('focus', focus); return () => { stopped = true; clearTimeout(timer); window.removeEventListener('focus', focus); }; }, [state.user?.id, refresh]);
 async function mutate<T = { ok: boolean }>(path: string, method = 'POST', body?: unknown): Promise<T> { const result = await api<T>(path, method, body); await refresh(); return result; }
 async function logout() { await api('/auth/logout', 'POST'); ++sequence.current; setState(empty); void clearBrowserPush().catch(() => {}); }
 function toast(text: string) { setNotice(text); clearTimeout(toastTimer.current); toastTimer.current = window.setTimeout(() => setNotice(''), 6000); }
 return <Context.Provider value={{ state, user: state.user, loading, online, error, refresh, mutate, logout, toast }}>{children}{notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Закрыть уведомление">×</button></div>}</Context.Provider>;
}
export const useApp = () => useContext(Context);
export function useAction() { const { toast } = useApp(); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const lock = useRef(false); async function run(fn: () => Promise<unknown>) { if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { await fn(); } catch (e) { const text = e instanceof Error ? e.message : 'Не удалось сохранить'; setError(text); toast(text); } finally { lock.current = false; setBusy(false); } } return { busy, error, run }; }
export async function uploadAudio(blob: Blob, patientId: string, purpose: string, visitId?: string) { const data = new FormData(); data.append('audio', blob, 'recording'); data.append('patientId', patientId); data.append('purpose', purpose); data.append('consent', 'true'); if (visitId) data.append('visitId', visitId); return api<{ id: string }>('/media', 'POST', data); }
export const uid = () => crypto.randomUUID();
export const initials = (name: string) => name.split(' ').filter(Boolean).slice(0, 2).map(p => p[0]).join('');
export const today = (timezone = 'Europe/Moscow') => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const dayLabel = (date: string) => new Date(date.slice(0, 10) + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
export const dateTime = (date: string) => new Date(date).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const sosLabel = (s: Sos) => s.closed ? 'Завершено врачом' : s.answered ? 'Врач ответил' : s.delivered ? 'Врач открыл обращение' : 'Отправлено · ожидает врача';
