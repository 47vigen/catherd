import { Button, Description, Input, Label, Radio, RadioGroup, TextField } from "@heroui/react";
import type { ReactNode } from "react";

import type { Found } from "../-lib/issues";

/** The checks that belong to one field, inline where it is edited. */
export function IssueList({ issues }: { issues: Found[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {issues.map((i, n) => (
        <li key={n} className={i.error ? "text-danger text-xs" : "text-warning text-xs"}>
          {i.path}: {i.message}
          {i.fix ? ` (${i.fix})` : ""}
        </li>
      ))}
    </ul>
  );
}

/** One group of settings: a heading, one line on what it does, the fields, the checks, and its own review button. */
export function SettingSection({
  id,
  title,
  meaning,
  issues = [],
  dirty,
  valid = true,
  disabled,
  onReview,
  children,
}: {
  id: string;
  title: ReactNode;
  meaning: string;
  issues?: Found[];
  dirty: boolean;
  valid?: boolean;
  disabled: boolean;
  onReview(): void;
  children: ReactNode;
}) {
  return (
    <section
      id={`setup-${id}`}
      tabIndex={-1}
      aria-labelledby={`setup-${id}-title`}
      className="border-border bg-surface flex scroll-mt-4 flex-col gap-3 rounded-sm border p-4 outline-none"
    >
      <div className="flex flex-col gap-0.5">
        <h3 id={`setup-${id}-title`} className="text-sm font-medium">
          {title}
        </h3>
        <p className="text-muted text-xs">{meaning}</p>
      </div>
      {children}
      <IssueList issues={issues} />
      <div>
        <Button size="sm" variant="secondary" isDisabled={disabled || !dirty || !valid} onPress={onReview}>
          Review changes
        </Button>
      </div>
    </section>
  );
}

/** A number typed as text, so it can be empty; `invalid` says what is wrong once something is typed. */
export function NumberText({
  label,
  unit,
  value,
  onChange,
  invalid,
  placeholder,
  disabled,
}: {
  label: string;
  unit?: string;
  value: string;
  onChange(v: string): void;
  invalid?: string;
  placeholder?: string;
  disabled: boolean;
}) {
  return (
    <TextField
      value={value}
      onChange={onChange}
      isInvalid={invalid !== undefined}
      isDisabled={disabled}
      inputMode="decimal"
      className="w-40"
    >
      <Label>{label}</Label>
      <Input placeholder={placeholder} />
      {invalid ? <p className="text-danger text-xs">{invalid}</p> : unit ? <Description>{unit}</Description> : null}
    </TextField>
  );
}

/** A small set of exclusive choices side by side, each with an optional plain line under it. */
export function Choice<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: T;
  onChange(v: T): void;
  options: readonly { id: T; label: string; description?: string }[];
  disabled: boolean;
}) {
  return (
    <RadioGroup
      aria-label={label}
      orientation="horizontal"
      value={value}
      onChange={(v) => onChange(v as T)}
      isDisabled={disabled}
      className="flex-wrap gap-x-5 gap-y-2"
    >
      {options.map((o) => (
        <Radio key={o.id} value={o.id}>
          <Radio.Content>
            <Radio.Control>
              <Radio.Indicator />
            </Radio.Control>
            {o.label}
          </Radio.Content>
          {o.description ? <Description>{o.description}</Description> : null}
        </Radio>
      ))}
    </RadioGroup>
  );
}
