# Vendored design system

These files are a **verbatim mirror** of the foundation layer of the
`Cloud Coding Agents Design System` project on claude.ai/design
(project `1601198e-90fc-4290-9ca6-2247dbb92e0c`).

Do not hand-edit them. Change a token upstream, then re-sync with the
`design-system` skill (`.claude/skills/design-system/SKILL.md`), which reads the
remote files through the `DesignSync` tool and rewrites this directory.

| Path | Upstream path |
|---|---|
| `styles.css` | `styles.css` |
| `tokens/*.css` | `tokens/*.css` |

Application styling lives in `src/client/styles.css`, which imports this
directory and then styles the app's own classes using only these tokens.

The component sources (`components/core`, `components/agent`, …) are **not**
vendored. They are JSX reference implementations with inline styles; this app is
TypeScript with a stylesheet. Read them on demand via `DesignSync` when building
a new component — the skill explains how.
