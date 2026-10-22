import { Tooltip } from "@heroui/react";
import type { ReactNode } from "react";
import { Focusable } from "react-aria-components/Focusable";

import { GLOSSARY, type GlossaryTerm } from "../../lib/glossary";

/** A glossary word as a label: dotted underline, its plain definition on hover and on keyboard focus. */
export function Term({ name, children }: { name: GlossaryTerm; children?: ReactNode }) {
  return (
    <Tooltip>
      <Focusable>
        <span className="focus-visible:outline-focus cursor-help underline decoration-dotted decoration-1 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">
          {children ?? name}
        </span>
      </Focusable>
      <Tooltip.Content className="max-w-64 text-xs leading-5">{GLOSSARY[name]}</Tooltip.Content>
    </Tooltip>
  );
}
