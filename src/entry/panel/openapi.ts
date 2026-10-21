import { z } from "zod";
import {
  CheckSchema,
  IndexedPairSchema,
  IssueSchema,
  ProfileSavedSchema,
  SetupViewSchema,
} from "../../services/panel-setup.ts";
import { ParkedViewSchema, RunViewSchema, TimelineEntrySchema } from "../../services/run-read.ts";

// The panel's HTTP API, in one table: it writes web/openapi.json (the web client is generated from it) and the
// server parses every request with the same schemas, so the document and the server cannot drift.

export const ErrorBodySchema = z.object({
  error: z.object({ message: z.string(), type: z.string(), code: z.string(), fix: z.string().optional() }),
});

const Page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), total: z.number().int() });

export const LoginBodySchema = z.object({ token: z.string().min(1).max(200) });
export const RungsBodySchema = z.object({ rungs: z.array(z.string().min(1)).max(50) });
export const AnswerBodySchema = z.object({
  unit: z.string().min(1).max(100),
  answer: z.string().trim().min(1).max(10000),
});
export const AnswerResultSchema = z.object({ unit: z.string(), parked: z.array(z.string()) });
export const CancelResultSchema = z.object({ cancelling: z.literal(true), live: z.array(z.string()) });
export const SessionSchema = z.object({ authenticated: z.literal(true) });
export const VersionSchema = z.object({ catherd: z.string() });
export const RunListSchema = Page(RunViewSchema);
export const TimelinePageSchema = Page(TimelineEntrySchema);
export const QuestionListSchema = Page(ParkedViewSchema);

const paging = {
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).default(0),
};
export const ListRunsQuerySchema = z.object({
  q: z.string().max(200).optional(),
  phase: z.enum(["planning", "approval", "running", "ended"]).optional(),
  ...paging,
});
export const TimelineQuerySchema = z.object(paging);
export const QuestionsQuerySchema = z.object({
  run: z.string().max(200).optional(),
  q: z.string().max(200).optional(),
  ...paging,
});

export type OperationId =
  | "login"
  | "logout"
  | "getSession"
  | "getVersion"
  | "getSetup"
  | "setRoleRungs"
  | "listRuns"
  | "getRun"
  | "getRunTimeline"
  | "cancelRun"
  | "answerUnit"
  | "listQuestions";

export interface Operation {
  id: OperationId;
  method: "GET" | "POST" | "PUT";
  path: string;
  public?: true;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** null: 204 */
  response: z.ZodType | null;
}

export const OPERATIONS: readonly Operation[] = [
  {
    id: "login",
    method: "POST",
    path: "/api/auth/login",
    public: true,
    body: LoginBodySchema,
    response: null,
  },
  { id: "logout", method: "POST", path: "/api/auth/logout", response: null },
  { id: "getSession", method: "GET", path: "/api/auth/session", response: SessionSchema },
  { id: "getVersion", method: "GET", path: "/api/system/version", response: VersionSchema },
  { id: "getSetup", method: "GET", path: "/api/setup", response: SetupViewSchema },
  {
    id: "setRoleRungs",
    method: "PUT",
    path: "/api/setup/roles/{role}",
    body: RungsBodySchema,
    response: ProfileSavedSchema,
  },
  { id: "listRuns", method: "GET", path: "/api/runs", query: ListRunsQuerySchema, response: RunListSchema },
  { id: "getRun", method: "GET", path: "/api/runs/{id}", response: RunViewSchema },
  {
    id: "getRunTimeline",
    method: "GET",
    path: "/api/runs/{id}/timeline",
    query: TimelineQuerySchema,
    response: TimelinePageSchema,
  },
  { id: "cancelRun", method: "POST", path: "/api/runs/{id}/cancel", response: CancelResultSchema },
  {
    id: "answerUnit",
    method: "POST",
    path: "/api/runs/{id}/answers",
    body: AnswerBodySchema,
    response: AnswerResultSchema,
  },
  {
    id: "listQuestions",
    method: "GET",
    path: "/api/questions",
    query: QuestionsQuerySchema,
    response: QuestionListSchema,
  },
];

const SCHEMAS: Record<string, z.ZodType> = {
  RunView: RunViewSchema,
  ParkedView: ParkedViewSchema,
  TimelineEntry: TimelineEntrySchema,
  SetupView: SetupViewSchema,
  Check: CheckSchema,
  Issue: IssueSchema,
  IndexedPair: IndexedPairSchema,
  ProfileSaved: ProfileSavedSchema,
  ErrorBody: ErrorBodySchema,
  RunList: RunListSchema,
  TimelinePage: TimelinePageSchema,
  QuestionList: QuestionListSchema,
  Session: SessionSchema,
  Version: VersionSchema,
  LoginBody: LoginBodySchema,
  RungsBody: RungsBodySchema,
  AnswerBody: AnswerBodySchema,
  AnswerResult: AnswerResultSchema,
  CancelResult: CancelResultSchema,
};

const REF = "#/components/schemas/";
const nameOf = (s: z.ZodType): string => {
  const hit = Object.entries(SCHEMAS).find(([, v]) => v === s);
  if (!hit) throw new Error("an operation names a schema that panelOpenApi does not register");
  return hit[0];
};
const refOf = (s: z.ZodType) => ({ $ref: REF + nameOf(s) });
const json = (s: z.ZodType) => ({ content: { "application/json": { schema: refOf(s) } } });

const without = ({ $schema: _s, $id: _i, ...rest }: Record<string, unknown>) => rest;

/** The OpenAPI 3.1 document of OPERATIONS; `info.version` is the API's, never the package's. */
export function panelOpenApi(): Record<string, unknown> {
  const reg = z.registry<{ id: string }>();
  for (const [id, s] of Object.entries(SCHEMAS)) reg.add(s, { id });
  const out = z.toJSONSchema(reg, { uri: (id) => REF + id, io: "output" }) as {
    schemas: Record<string, Record<string, unknown>>;
  };
  const schemas = Object.fromEntries(Object.entries(out.schemas).map(([k, v]) => [k, without(v)]));
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const pathParams = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    const queryParams = Object.entries(op.query?.shape ?? {}).map(([name, field]) => ({
      name,
      in: "query",
      required: !(field as z.ZodType).safeParse(undefined).success,
      schema: without(z.toJSONSchema(field as z.ZodType, { io: "input" }) as Record<string, unknown>),
    }));
    (paths[op.path] ??= {})[op.method.toLowerCase()] = {
      operationId: op.id,
      parameters: [...pathParams, ...queryParams],
      ...(op.body ? { requestBody: { required: true, ...json(op.body) } } : {}),
      responses: {
        [op.response ? "200" : "204"]: op.response
          ? { description: "ok", ...json(op.response) }
          : { description: "no content" },
        default: { description: "error", ...json(ErrorBodySchema) },
      },
    };
  }
  return { openapi: "3.1.0", info: { title: "catherd panel", version: "1" }, paths, components: { schemas } };
}
