import type { ReactNode } from "react";

export function AuthCard({ children }: { children: ReactNode }) {
  return <section className="auth-card">{children}</section>;
}
