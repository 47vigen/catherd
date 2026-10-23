import { Button, Description, Input, Label, Switch, TextField, ToggleButton, ToggleButtonGroup } from "@heroui/react";
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
      className="bg-surface flex scroll-mt-4 flex-col gap-3 p-4 outline-none"
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 id={`setup-${id}-title`} className="text-sm font-medium">
            {title}
          </h3>
          <p className="text-muted text-xs">{meaning}</p>
        </div>
        {dirty ? (
          <Button size="sm" variant="primary" isDisabled={disabled || !valid} onPress={onReview}>
            Review changes
          </Button>
        ) : null}
      </div>
      {children}
      <IssueList issues={issues} />
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
  className = "w-40",
}: {
  className?: string;
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
      className={className}
    >
      <Label>{label}</Label>
      <Input placeholder={placeholder} />
      {invalid ? <p className="text-danger text-xs">{invalid}</p> : unit ? <Description>{unit}</Description> : null}
    </TextField>
  );
}

/** A small set of exclusive choices as one segmented control; the chosen one's plain line sits under it. */
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
  const line = options.find((o) => o.id === value)?.description;
  return (
    <div className="flex flex-col gap-1.5">
      <ToggleButtonGroup
        aria-label={label}
        selectionMode="single"
        disallowEmptySelection
        size="sm"
        isDisabled={disabled}
        selectedKeys={[value]}
        onSelectionChange={(keys) => {
          const next = [...keys][0];
          if (next !== undefined) onChange(next as T);
        }}
        className="self-start"
      >
        {options.map((o, i) => (
          <ToggleButton
            key={o.id}
            id={o.id}
            className="data-[selected]:bg-accent data-[selected]:text-accent-foreground"
          >
            {i > 0 ? <ToggleButtonGroup.Separator /> : null}
            {o.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      {line ? <p className="text-muted text-xs">{line}</p> : null}
    </div>
  );
}

/** A switch whose label is for screen readers only; the words around it say what it does. */
export function OnOff({
  label,
  isSelected,
  onChange,
  disabled,
}: {
  label: string;
  isSelected: boolean;
  onChange(v: boolean): void;
  disabled: boolean;
}) {
  return (
    <Switch isSelected={isSelected} isDisabled={disabled} onChange={onChange}>
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Label className="sr-only">{label}</Label>
      </Switch.Content>
    </Switch>
  );
}

/** A setting that is on or off: its label and what it means on the left, the switch on the right. */
export function SwitchRow({
  label,
  hint,
  isSelected,
  onChange,
  disabled,
  ariaLabel,
}: {
  label: string;
  hint?: string;
  isSelected: boolean;
  onChange(v: boolean): void;
  disabled: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm">{label}</span>
        {hint ? <span className="text-muted text-xs">{hint}</span> : null}
      </div>
      <OnOff label={ariaLabel ?? label} isSelected={isSelected} disabled={disabled} onChange={onChange} />
    </div>
  );
}
