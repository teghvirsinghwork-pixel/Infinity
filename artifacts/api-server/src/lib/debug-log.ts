export interface DebugEntry {
  id: number;
  time: string;
  method: string;
  path: string;
  rangeHeader?: string;
  targetUrl?: string;
  status: number;
  contentType?: string;
  bytesSent?: number;
  durationMs: number;
  error?: string;
}

export interface ResolveEvent {
  id: number;
  time: string;
  imdbId: string;
  step: string;
  status: "ok" | "fail" | "skip";
  detail: string;
}

const MAX = 100;

const proxyEntries: DebugEntry[] = [];
let proxyCounter = 0;

const resolveEvents: ResolveEvent[] = [];
let resolveCounter = 0;

export function logDebug(entry: Omit<DebugEntry, "id" | "time">): void {
  proxyCounter++;
  proxyEntries.unshift({ id: proxyCounter, time: new Date().toISOString(), ...entry });
  if (proxyEntries.length > MAX) proxyEntries.splice(MAX);
}

export function getEntries(): DebugEntry[] { return proxyEntries; }

export function logResolve(event: Omit<ResolveEvent, "id" | "time">): void {
  resolveCounter++;
  resolveEvents.unshift({ id: resolveCounter, time: new Date().toISOString(), ...event });
  if (resolveEvents.length > MAX) resolveEvents.splice(MAX);
}

export function getResolveEvents(): ResolveEvent[] { return resolveEvents; }

export function clearEntries(): void {
  proxyEntries.splice(0);
  resolveEvents.splice(0);
}

// ─── Per-provider error tracking ─────────────────────────────────────────────

export interface ProviderErrorEntry {
  message: string;
  time: string;
  count: number;
}

const providerErrors = new Map<string, ProviderErrorEntry>();

export function logProviderError(provider: string, error: unknown): void {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  const existing = providerErrors.get(provider);
  providerErrors.set(provider, {
    message: message.slice(0, 400),
    time: new Date().toISOString(),
    count: (existing?.count ?? 0) + 1,
  });
}

export function getProviderErrors(): Record<string, ProviderErrorEntry> {
  return Object.fromEntries(providerErrors.entries());
}

export function clearProviderErrors(): void {
  providerErrors.clear();
}
