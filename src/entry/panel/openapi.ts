import { z } from "zod";
import { ProfilePatchSchema } from "../../domain/profile.ts";
import {
  AttemptSchema,
  EdgeSchema,
  RunModelPatchSchema,
  RunModelSchema,
  RunNodeSchema,
} from "../../domain/run-graph.ts";
import { TranscriptItemSchema, TranscriptPageSchema } from "../../domain/transcript.ts";
import { NowLineSchema, OverviewSchema } from "../../services/overview.ts";
import {
  CheckSchema,
  IndexedPairSchema,
  IssueSchema,
  ProfileSavedSchema,
  SettingsSchema,
  SetupViewSchema,
} from "../../services/panel-setup.ts";
import { CheckLogsSchema, CommitDiffSchema, DispatchDetailSchema } from "../../services/run-files.ts";
import { RunCardSchema } from "../../services/run-index.ts";
import { QuestionContextSchema } from "../../services/run-model.ts";
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
export const VersionSchema = z.object({
  catherd: z.string(),
  host: z.enum(["claude-code", "codex", "unknown"]),
});
export const RunListSchema = Page(RunCardSchema);
export const TimelinePageSchema = Page(TimelineEntrySchema);
export const QuestionViewSchema = ParkedViewSchema.extend({ context: QuestionContextSchema });
export const QuestionListSchema = Page(QuestionViewSchema);
export const AnsweredListSchema = z.object({
  items: z.array(
    z.object({
      run: z.string(),
      runTitle: z.string(),
      unit: z.string(),
      answer: z.string(),
      by: z.enum(["owner", "judge"]),
      at: z.string(),
    }),
  ),
});
export const RunDocSchema = z.object({ name: z.string(), text: z.string() });
export const PauseResultSchema = z.object({ paused: z.literal(true), since: z.string() });
export const ResumeResultSchema = z.object({ paused: z.literal(false) });
export const CancelRoleResultSchema = z.object({ name: z.string(), status: z.string() });
/** What a save would do, and the stored profile it was worked out from (sent back with the save as `expect`). */
export const ProfilePreviewSchema = ProfileSavedSchema.extend({ expect: z.record(z.string(), z.unknown()) });
export const PreviewBodySchema = z.object({ patch: ProfilePatchSchema });
export const SaveProfileBodySchema = z.object({
  patch: ProfilePatchSchema,
  expect: z.record(z.string(), z.unknown()),
});
export const NotifyUrlBodySchema = z.object({ url: z.string().min(1).max(2000) });
export const CreateProfileBodySchema = z.object({
  name: z.string().min(1).max(100),
  from: z.string().min(1).max(100).optional(),
});
export const ActivateBodySchema = z.object({ repo: z.string().min(1).max(4000).nullable() });
export const HostBodySchema = z.object({ host: z.enum(["claude-code", "codex"]) });

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "not a date");
/** Absent: the repo the panel was started in. `global`: the active profile, no repo (Ruling 16). */
const setupRepo = z.string().min(1).max(4000).optional();

const paging = {
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).default(0),
};
export const ListRunsQuerySchema = z.object({
  q: z.string().max(200).optional(),
  phase: z.enum(["planning", "approval", "running", "ended"]).optional(),
  repo: z.string().max(4000).optional(),
  ...paging,
});
/** `types`: a comma list of event types to keep. */
export const TimelineQuerySchema = z.object({ ...paging, types: z.string().max(2000).optional() });
export const OverviewQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  repo: z.string().max(4000).optional(),
});
export const StreamQuerySchema = z.object({
  from: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  raw: z.enum(["0", "1"]).default("0"),
});
export const DocQuerySchema = z.object({ name: z.string().min(1).max(200) });
export const DiffQuerySchema = z.object({ lane: z.string().min(1).max(200).optional() });
export const SetupQuerySchema = z.object({ repo: setupRepo });
export const QuestionsQuerySchema = z.object({
  run: z.string().max(200).optional(),
  q: z.string().max(200).optional(),
  ...paging,
});
export const AnsweredQuerySchema = z.object({ run: z.string().max(200).optional() });

export type OperationId =
  | "login"
  | "logout"
  | "getSession"
  | "getVersion"
  | "getOverview"
  | "getSetup"
  | "recheckSetup"
  | "previewProfile"
  | "saveProfile"
  | "setNotifyUrl"
  | "setHost"
  | "setRoleRungs"
  | "createProfile"
  | "deleteProfile"
  | "activateProfile"
  | "listRuns"
  | "getRun"
  | "getRunModel"
  | "getDispatch"
  | "getDispatchStream"
  | "getRunDoc"
  | "getCommitDiff"
  | "getCheckLogs"
  | "getRunTimeline"
  | "cancelRun"
  | "pauseRun"
  | "resumeRun"
  | "cancelRole"
  | "answerUnit"
  | "listQuestions"
  | "listAnswered";

export interface Operation {
  id: OperationId;
  method: "GET" | "POST" | "PUT" | "DELETE";
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
  {
    id: "getOverview",
    method: "GET",
    path: "/api/overview",
    query: OverviewQuerySchema,
    response: OverviewSchema,
  },
  { id: "getSetup", method: "GET", path: "/api/setup", query: SetupQuerySchema, response: SetupViewSchema },
  {
    id: "recheckSetup",
    method: "POST",
    path: "/api/setup/recheck",
    query: SetupQuerySchema,
    response: SetupViewSchema,
  },
  {
    id: "previewProfile",
    method: "POST",
    path: "/api/setup/preview",
    query: SetupQuerySchema,
    body: PreviewBodySchema,
    response: ProfilePreviewSchema,
  },
  {
    id: "saveProfile",
    method: "PUT",
    path: "/api/setup/profile",
    query: SetupQuerySchema,
    body: SaveProfileBodySchema,
    response: ProfileSavedSchema,
  },
  {
    id: "setNotifyUrl",
    method: "PUT",
    path: "/api/setup/notify-url",
    body: NotifyUrlBodySchema,
    response: null,
  },
  { id: "setHost", method: "POST", path: "/api/setup/host", body: HostBodySchema, response: null },
  {
    id: "setRoleRungs",
    method: "PUT",
    path: "/api/setup/roles/{role}",
    query: SetupQuerySchema,
    body: RungsBodySchema,
    response: ProfileSavedSchema,
  },
  {
    id: "createProfile",
    method: "POST",
    path: "/api/profiles",
    body: CreateProfileBodySchema,
    response: ProfileSavedSchema,
  },
  { id: "deleteProfile", method: "DELETE", path: "/api/profiles/{name}", response: null },
  {
    id: "activateProfile",
    method: "POST",
    path: "/api/profiles/{name}/activate",
    body: ActivateBodySchema,
    response: null,
  },
  { id: "listRuns", method: "GET", path: "/api/runs", query: ListRunsQuerySchema, response: RunListSchema },
  { id: "getRun", method: "GET", path: "/api/runs/{id}", response: RunViewSchema },
  { id: "getRunModel", method: "GET", path: "/api/runs/{id}/model", response: RunModelSchema },
  {
    id: "getDispatch",
    method: "GET",
    path: "/api/runs/{id}/dispatches/{dispatchId}",
    response: DispatchDetailSchema,
  },
  {
    id: "getDispatchStream",
    method: "GET",
    path: "/api/runs/{id}/dispatches/{dispatchId}/stream",
    query: StreamQuerySchema,
    response: TranscriptPageSchema,
  },
  {
    id: "getRunDoc",
    method: "GET",
    path: "/api/runs/{id}/docs",
    query: DocQuerySchema,
    response: RunDocSchema,
  },
  {
    id: "getCommitDiff",
    method: "GET",
    path: "/api/runs/{id}/commits/{sha}/diff",
    query: DiffQuerySchema,
    response: CommitDiffSchema,
  },
  { id: "getCheckLogs", method: "GET", path: "/api/runs/{id}/checks/{lane}", response: CheckLogsSchema },
  {
    id: "getRunTimeline",
    method: "GET",
    path: "/api/runs/{id}/timeline",
    query: TimelineQuerySchema,
    response: TimelinePageSchema,
  },
  { id: "cancelRun", method: "POST", path: "/api/runs/{id}/cancel", response: CancelResultSchema },
  { id: "pauseRun", method: "POST", path: "/api/runs/{id}/pause", response: PauseResultSchema },
  { id: "resumeRun", method: "POST", path: "/api/runs/{id}/resume", response: ResumeResultSchema },
  {
    id: "cancelRole",
    method: "POST",
    path: "/api/runs/{id}/roles/{name}/cancel",
    response: CancelRoleResultSchema,
  },
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
  {
    id: "listAnswered",
    method: "GET",
    path: "/api/questions/answered",
    query: AnsweredQuerySchema,
    response: AnsweredListSchema,
  },
];

const SCHEMAS: Record<string, z.ZodType> = {
  RunView: RunViewSchema,
  RunCard: RunCardSchema,
  RunModel: RunModelSchema,
  RunModelPatch: RunModelPatchSchema,
  RunNode: RunNodeSchema,
  Attempt: AttemptSchema,
  Edge: EdgeSchema,
  Overview: OverviewSchema,
  NowLine: NowLineSchema,
  DispatchDetail: DispatchDetailSchema,
  TranscriptPage: TranscriptPageSchema,
  TranscriptItem: TranscriptItemSchema,
  RunDoc: RunDocSchema,
  CommitDiff: CommitDiffSchema,
  CheckLogs: CheckLogsSchema,
  QuestionContext: QuestionContextSchema,
  QuestionView: QuestionViewSchema,
  AnsweredList: AnsweredListSchema,
  ProfilePatch: ProfilePatchSchema,
  ProfilePreview: ProfilePreviewSchema,
  Settings: SettingsSchema,
  PreviewBody: PreviewBodySchema,
  SaveProfileBody: SaveProfileBodySchema,
  NotifyUrlBody: NotifyUrlBodySchema,
  CreateProfileBody: CreateProfileBodySchema,
  ActivateBody: ActivateBodySchema,
  HostBody: HostBodySchema,
  PauseResult: PauseResultSchema,
  ResumeResult: ResumeResultSchema,
  CancelRoleResult: CancelRoleResultSchema,
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
