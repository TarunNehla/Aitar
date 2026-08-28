import { useId } from "react";

export function AuthField({
  label,
  value,
  type,
  autoComplete,
  disabled,
  error,
  onChange,
}: {
  label: string;
  value: string;
  type: "text" | "email";
  autoComplete: "name" | "email";
  disabled?: boolean;
  error?: string | null;
  onChange: (value: string) => void;
}) {
  const inputId = useId();
  const errorId = `${inputId}-error`;

  return (
    <div className="auth-field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        type={type}
        value={value}
        autoComplete={autoComplete}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error && (
        <small className="field-error" id={errorId}>
          {error}
        </small>
      )}
    </div>
  );
}
