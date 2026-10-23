import { Markdown } from "../../../../../components/markdown/Markdown";
import { Empty, type DispatchQuery, WithDispatch } from "./parts";

const NONE = "No prompt was recorded.";

/** The brief the role was given, rendered, with a copy button. */
export function PromptTab({ dispatch }: { dispatch: DispatchQuery }) {
  return (
    <WithDispatch dispatch={dispatch} none={NONE}>
      {(d) =>
        d.brief ? (
          <div className="flex flex-col gap-2">
            {d.truncated.includes("brief") ? (
              <p className="text-muted text-xs">The prompt is long, so only its start is shown.</p>
            ) : null}
            <Markdown source={d.brief} />
          </div>
        ) : (
          <Empty>{NONE}</Empty>
        )
      }
    </WithDispatch>
  );
}
