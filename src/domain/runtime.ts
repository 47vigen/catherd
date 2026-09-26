/** Spec §3.1 and D6: catherd runs on Bun 1.4.0 or newer. */
export const MIN_BUN = "1.4.0";

const parts = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1) ?? ["0", "0", "0"]).map(Number);

export function bunTooOld(version: string, min: string = MIN_BUN): boolean {
  const a = parts(version);
  const b = parts(min);
  for (let i = 0; i < 3; i++)
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) < (b[i] as number);
  return false;
}

/** The two lines to print, and exit 1 on, when this Bun is too old; null when it is new enough. */
export function runtimeRefusal(version: string | undefined): string[] | null {
  if (version !== undefined && !bunTooOld(version)) return null;
  return [
    `error E_RUNTIME_TOO_OLD: catherd needs Bun ${MIN_BUN} or newer; this is ${version ? `Bun ${version}` : "not Bun"}`,
    "fix: bun upgrade (or install Bun: curl -fsSL https://bun.sh/install | bash)",
  ];
}
