import { useId, useState } from "react";
import { Icon } from "../../components/Icon";

export function PasswordField({
  label,
  value,
  autoComplete,
  disabled,
  error,
  requirement,
  onChange,
}: {
  label: string;
  value: string;
  autoComplete: "current-password" | "new-password";
  disabled?: boolean;
  error?: string | null;
  requirement?: string;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const requirementId = `${inputId}-requirement`;
  const showRequirement = Boolean(requirement) && (focused || Boolean(error));
  const describedBy = [showRequirement ? requirementId : null, error ? errorId : null]
    .filter(Boolean)
    .join(" ");

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
          aria-describedby={describedBy || undefined}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <button
          className="password-toggle"
          type="button"
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={visible}
          disabled={disabled}
          onClick={() => setVisible((current) => !current)}
        >
          <Icon name={visible ? "eye-off" : "eye"} size={16} />
        </button>
      </div>
      {showRequirement && !error && (
        <small className="field-hint" id={requirementId}>
          {requirement}
        </small>
      )}
      {error && (
        <small className="field-error" id={errorId}>
          {error}
        </small>
      )}
    </div>
  );
}
