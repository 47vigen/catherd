/** The event groups the timeline can be narrowed to; `types` is the comma list the API takes. */
export const TIMELINE_FILTERS = [
  { id: "dispatches", label: "Dispatches", types: "dispatch.started,dispatch.ended" },
  { id: "checks", label: "Checks", types: "check.requested,check.done" },
  { id: "questions", label: "Questions", types: "question.parked,question.answered" },
  { id: "control", label: "Pause and cancel", types: "run.paused,run.resumed,cancel.requested" },
] as const;

export type TimelineFilterId = (typeof TIMELINE_FILTERS)[number]["id"];

export const filterIdOf = (types: string | undefined): TimelineFilterId | undefined =>
  TIMELINE_FILTERS.find((f) => f.types === types)?.id;

/** Whether an event of `type` passes the filter (no filter passes everything). */
export const matchesTypes = (types: string | undefined, type: string): boolean =>
  !types || types.split(",").includes(type);
