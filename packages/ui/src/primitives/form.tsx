// 表单原语：带标签与说明的输入框、下拉框、多行文本，以及按钮组式的单选（过滤条件）。

import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import styles from './form.module.css';

interface FieldShell {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

function Shell({ id, label, hint, error, children }: FieldShell & { id: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      {children}
      {hint && (
        <div id={`${id}-hint`} className={styles.hint}>
          {hint}
        </div>
      )}
      {error && (
        <div id={`${id}-err`} className={styles.error} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

const describedBy = (id: string, f: FieldShell) =>
  [f.hint ? `${id}-hint` : '', f.error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined;

export function TextField({
  label,
  hint,
  error,
  ...rest
}: FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <input
        {...rest}
        id={id}
        className={styles.input}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, { label, hint, error })}
      />
    </Shell>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  ...rest
}: FieldShell & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <textarea
        {...rest}
        id={id}
        className={styles.input}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, { label, hint, error })}
      />
    </Shell>
  );
}

export function SelectField({
  label,
  hint,
  error,
  options,
  placeholder,
  ...rest
}: FieldShell &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> & {
    options: ReadonlyArray<{ value: string; label: string }>;
    placeholder?: string;
  }) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <select
        {...rest}
        id={id}
        className={styles.input}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, { label, hint, error })}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Shell>
  );
}

/** 按钮组式的单选；过滤条件、两档切换（快照 / 重建）等。 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={styles.segment}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
