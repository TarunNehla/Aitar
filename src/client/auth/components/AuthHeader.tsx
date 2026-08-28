import { brandName } from "../auth-copy";
import { Icon, type IconName } from "../../components/Icon";

export function AuthHeader({
  heading,
  helper,
  icon,
}: {
  heading: string;
  helper?: string;
  icon?: IconName;
}) {
  return (
    <header className="auth-header">
      <div className="brand">
        <span className="brand-placeholder" />
        <strong>{brandName}</strong>
      </div>
      {icon && (
        <span className="auth-mark">
          <Icon name={icon} size={20} />
        </span>
      )}
      <h1>{heading}</h1>
      {helper && <p className="auth-helper">{helper}</p>}
    </header>
  );
}
