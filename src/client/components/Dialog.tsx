import { useEffect, useId, type ReactNode } from "react";
import { Icon } from "./Icon";

export function Dialog({
  title,
  onBack,
  onClose,
  children,
}: {
  title: string;
  onBack?: () => void;
  onClose?: () => void;
  children: ReactNode;
}) {
  const titleId = useId();

  useEffect(() => {
    const close = onClose;
    if (!close) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close?.();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(event) => {
        if (onClose && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="dialog-header">
          {onBack && (
            <button className="icon-button" type="button" aria-label="Back" onClick={onBack}>
              <Icon name="arrow-left" size={16} />
            </button>
          )}
          <div className="dialog-heading">
            <h2 id={titleId}>{title}</h2>
          </div>
          {onClose && (
            <button className="dialog-close" type="button" aria-label="Close" onClick={onClose}>
              <Icon name="x" size={16} />
            </button>
          )}
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}
