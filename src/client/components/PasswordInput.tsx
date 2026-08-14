import { useId, useState } from "react";

export function PasswordInput({
  label,
  value,
  autoComplete,
  disabled,
  error,
  onChange,
}: {
  label: string;
  value: string;
  autoComplete: "current-password" | "new-password";
  disabled?: boolean;
  error?: string | null;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const inputId = useId();
  const errorId = `${inputId}-error`;

  return (
    <div className="auth-field">
      <label htmlFor={inputId}>{label}</label>
      <div className="password-input">
        <input
          id={inputId}
          type={visible ? "text" : "password"}
          value={value}
          autoComplete={autoComplete}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          className="password-toggle"
          type="button"
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={visible}
          disabled={disabled}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
      {error && <small className="field-error" id={errorId}>{error}</small>}
    </div>
  );
}
