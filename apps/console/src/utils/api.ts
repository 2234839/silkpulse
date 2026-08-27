/**
 * apiFetch —— 带 Authorization header 的 fetch 封装
 *
 * 控制台所有 HTTP 请求都应通过此函数，自动携带鉴权 header。
 */
import { useAuth } from "../composables/useAuth";

export function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const { apiKey } = useAuth();
  const headers = new Headers(options.headers);
  if (apiKey.value) headers.set("Authorization", `Bearer ${apiKey.value}`);
  return fetch(url, { ...options, headers });
}

/** apiFetch 的 JSON 版本（自动解析响应体） */
export async function apiFetchJson<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await apiFetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}
