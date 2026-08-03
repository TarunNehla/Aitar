const alwaysBlocked = [
  /(^|\s)sudo(\s|$)/i,
  /(^|\s)docker(\s|$)/i,
  /(^|\s)mount(\s|$)/i,
  /(^|\s)shutdown(\s|$)/i,
  /(^|\s)reboot(\s|$)/i,
  /(^|\s)git\s+push(\s|$)/i,
];

const requiresUserApproval = [
  /(^|\s)rm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)(\s|$)/i,
  /(^|\s)(curl|wget)(\s|$)/i,
  /(^|\s)(npm|pnpm|yarn|pip|uv|cargo)\s+(install|add)(\s|$)/i,
  /(^|\s)git\s+(reset|clean)(\s|$)/i,
  /(^|\s)chmod(\s|$)/i,
];

export function inspectCommand(command: string, network: boolean): {
  allowed: boolean;
  approvalRequired: boolean;
  reason?: string;
} {
  if (alwaysBlocked.some((pattern) => pattern.test(command))) {
    return { allowed: false, approvalRequired: false, reason: "This command is blocked by the V0 sandbox policy" };
  }

  if (network || requiresUserApproval.some((pattern) => pattern.test(command))) {
    return { allowed: true, approvalRequired: true, reason: network ? "This command requests network access" : "This command can make broad changes" };
  }

  return { allowed: true, approvalRequired: false };
}
