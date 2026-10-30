import { PromptView } from "../../../../../components/prompt-view/PromptView";
import { Empty, type DispatchQuery, WithDispatch } from "./parts";

const NONE = "No prompt was recorded.";

/** The brief the role was given, read as its sections, with its source and a copy button. */
export function PromptTab({ dispatch }: { dispatch: DispatchQuery }) {
  return (
    <WithDispatch dispatch={dispatch} none={NONE}>
      {(d) =>
        d.brief ? (
          <>
            {d.truncated.includes("brief") ? (
              <p className="text-muted text-xs">The prompt is long, so only its start is shown.</p>
            ) : null}
            <PromptView source={d.brief} />
          </>
        ) : (
          <Empty>{NONE}</Empty>
        )
      }
    </WithDispatch>
  );
}
