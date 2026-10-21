import { client } from "../client/client.gen";

const LOGIN_URL = "/api/auth/login";

let interceptor: number | undefined;

/**
 * Points the generated client at the same origin and calls `onUnauthorized` whenever a request other than the
 * login itself comes back 401 (the session expired or was revoked). A wrong password must not redirect.
 */
export function configureClient(onUnauthorized: () => void): void {
  client.setConfig({ baseUrl: "" });
  if (interceptor !== undefined) client.interceptors.response.eject(interceptor);
  interceptor = client.interceptors.response.use((response, _request, options) => {
    if (response.status === 401 && options.url !== LOGIN_URL) onUnauthorized();
    return response;
  });
}

/** Reads a human-readable message from an API error body, an `Error`, or anything else. */
export function errorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const detail = (err as { error?: unknown }).error;
    if (typeof detail === "object" && detail !== null) {
      const message = (detail as { message?: unknown }).message;
      if (typeof message === "string" && message !== "") return message;
    }
    if (err instanceof Error && err.message !== "") return err.message;
  }
  return "Request failed";
}

/** Reports whether an API error body carries the given error code. */
export function hasErrorCode(err: unknown, code: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const detail = (err as { error?: unknown }).error;
  return typeof detail === "object" && detail !== null && (detail as { code?: unknown }).code === code;
}
