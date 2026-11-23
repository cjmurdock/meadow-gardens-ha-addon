import { QueryClient, QueryFunction } from "@tanstack/react-query";

// Works at "/" and under Home Assistant Ingress ("/api/hassio_ingress/<token>/").
const API_BASE = window.location.pathname.replace(/\/index\.html$/, "").replace(/\/+$/, "");

// Password is stored in memory and injected into all requests
let _appPassword: string | null = null;

export function setAppPassword(pw: string) {
  _appPassword = pw;
}

export function getAppPassword(): string | null {
  return _appPassword;
}

export function clearAppPassword() {
  _appPassword = null;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (data) headers["Content-Type"] = "application/json";
  if (_appPassword) headers["x-app-password"] = _appPassword;

  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const headers: Record<string, string> = {};
    if (_appPassword) headers["x-app-password"] = _appPassword;

    const res = await fetch(`${API_BASE}${queryKey[0]}`, { headers });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: 30000,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
