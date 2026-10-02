// Plan 23: a host probe that fails once may have caught the network mid-change (a VPN just dropped, a route
// still settling). catherd's own host probes run twice, this far apart, before they call the host blocked.

/** The pause before the second try; tests shorten it. */
export const hostProbe = { retryMs: 5_000 };

/** `probe`, and once more after hostProbe.retryMs when `ok` says the first answer failed. */
export async function probeTwice<T>(
  probe: () => Promise<T>,
  ok: (r: T) => boolean,
): Promise<{ result: T; attempts: 1 | 2 }> {
  const first = await probe();
  if (ok(first)) return { result: first, attempts: 1 };
  await Bun.sleep(hostProbe.retryMs);
  return { result: await probe(), attempts: 2 };
}
