export type ErrorCode =
  | "E_CONFIG_INVALID"
  | "E_CONFIG_NEWER_SCHEMA"
  | "E_CONFIG_KEYBIND"
  | "E_BACKEND_MISSING"
  | "E_BACKEND_TOO_OLD"
  | "E_BACKEND_NOT_LOGGED_IN"
  | "E_BACKEND_MODEL_UNKNOWN"
  | "E_RUN_NOT_FOUND"
  | "E_RUN_CORRUPT"
  | "E_RUN_BUDGET"
  | "E_RUN_COMMIT"
  | "E_RUN_NOT_LIVE"
  | "E_ADMIT_RUNG"
  | "E_ADMIT_DUPLICATE"
  | "E_ADMIT_OVERLAP"
  | "E_ADMIT_ID"
  | "E_ADMIT_THREAD"
  | "E_LANE_INVALID"
  | "E_JEV_KEY"
  | "E_JEV_NETWORK"
  | "E_JEV_RESPONSE"
  | "E_IO_LOCK"
  | "E_IO_WRITE"
  | "E_IO_PATH"
  | "E_IO_UNEXPECTED"
  | "E_INPUT_INVALID"
  | "E_RUNTIME_TOO_OLD";

/** Every failure catherd reports: a stable code, a message, and the exact action that fixes it. */
export class CatherdError extends Error {
  readonly code: ErrorCode;
  readonly fix: string | undefined;

  constructor(code: ErrorCode, message: string, opts: { fix?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "CatherdError";
    this.code = code;
    this.fix = opts.fix;
  }

  toJSON(): { code: ErrorCode; message: string; fix?: string } {
    return this.fix === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, fix: this.fix };
  }
}

export const isCatherdError = (e: unknown): e is CatherdError => e instanceof CatherdError;
