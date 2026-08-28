import { Icon } from "../../components/Icon";

export function AuthStatus({ tone, message }: { tone: "error" | "success"; message: string }) {
  return (
    <div className={`auth-status ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon name={tone === "error" ? "alert-triangle" : "circle-check"} size={16} />
      <span>{message}</span>
    </div>
  );
}
