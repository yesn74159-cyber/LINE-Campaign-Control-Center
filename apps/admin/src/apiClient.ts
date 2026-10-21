const apiOrigin = (import.meta.env.VITE_API_ORIGIN || '').replace(/\/$/, '');

export function apiUrl(path: string) {
  return `${apiOrigin}${path}`;
}
