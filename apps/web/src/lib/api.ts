import { CONTRACT_MAJOR_PATH, CONTRACT_MINOR } from "@hpc/contract";

/**
 * Dual-context base URL:
 * - Server (SSR): `API_URL` (in-cluster Service DNS) -> `NEXT_PUBLIC_API_URL`.
 * - Browser: `NEXT_PUBLIC_API_URL` (public ingress, baked at build time).
 * Falls back to the local dev API port.
 */
export function apiBaseUrl(): string {
  if (typeof window === "undefined") {
    return process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  }
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
}

/** The contract version this build speaks. Re-exported so pages need one import. */
export const contract = { major: CONTRACT_MAJOR_PATH, minor: CONTRACT_MINOR } as const;

export class ApiClientError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
    credentials: "include",
    cache: "no-store",
  });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiClientError(res.status, body?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
};

export function getHealth(): Promise<{ status: string }> {
  return api.get<{ status: string }>("/health");
}
