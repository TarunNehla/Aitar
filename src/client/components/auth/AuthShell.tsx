import type { ReactNode } from "react";

export function AuthShell({ children }: { children: ReactNode }) {
  return <main className="auth-shell">{children}</main>;
}
