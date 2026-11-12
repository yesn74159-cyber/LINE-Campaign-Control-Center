export const apiOrigin = (import.meta.env.VITE_API_ORIGIN || '').replace(/\/$/, '');
const BANGKOK_OFFSET_MS = 7 * 60 * 60_000;
// The schedule field shows a wall clock in Asia/Bangkok no matter where the operator's
// laptop is, and the value goes back to the API with an explicit +07:00 offset so the
// server never has to guess which zone the reading belongs to.
export const bangkokDateTimeValue = (date: Date) => new Date(date.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 16);
export const parseBangkokInput = (value: string) => new Date(`${value.length === 16 ? `${value}:00` : value}+07:00`);
export const formatBangkok = (value: string) => { const parsed = parseBangkokInput(value); return Number.isNaN(parsed.valueOf()) ? 'วันเวลาไม่ถูกต้อง' : parsed.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }); };

export const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const headers = new Headers(options?.headers);
  const method = (options?.method || 'GET').toUpperCase();
  const csrf = document.cookie.split('; ').find((item) => item.startsWith('ccc_csrf='))?.slice('ccc_csrf='.length);
  if (csrf && method !== 'GET' && method !== 'HEAD') headers.set('x-csrf-token', decodeURIComponent(csrf));
  const response = await fetch(`${apiOrigin}${url}`, { ...options, headers, credentials: 'include' });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `Request failed (${response.status})`);
  return response.json() as Promise<T>;
};
