import type { BackendAdapter } from "./backend.ts";

const adapters = new Map<string, BackendAdapter>();

export function registerAdapter(a: BackendAdapter): void {
  adapters.set(a.id, a);
}

export const adapterFor = (id: string): BackendAdapter | null => adapters.get(id) ?? null;
