# Upstream component index

Project `1601198e-90fc-4290-9ca6-2247dbb92e0c` on claude.ai/design.

Fetch a source with:

```
DesignSync method=get_file projectId=1601198e-90fc-4290-9ca6-2247dbb92e0c path=<path>
```

Every component has three files beside each other — `Name.jsx` (the implementation),
`Name.d.ts` (prop contract), and `Name.prompt.md` (when and how to use it). Read the
`.d.ts` first if you only need the API; read the `.jsx` when you need the visual spec.

## Foundations

| Path | What's there |
|---|---|
| `readme.md` | The authority: voice, color, type, spacing, borders, motion, iconography, known gaps |
| `styles.css` | Import barrel (mirrored locally) |
| `tokens/*.css` | fonts · colors · typography · spacing · radius · elevation · motion · base (mirrored locally) |
| `guidelines/*.html` | Specimen cards — `type-*`, `color-*`, `spacing-*`, `brand-*` |

## Components

| Group | Path prefix | Components |
|---|---|---|
| Core | `components/core/` | Button, IconButton, Card, Badge, Tag |
| Forms | `components/forms/` | Input, Textarea, Select, Checkbox, Radio, Switch, Field |
| Navigation | `components/navigation/` | OrgSwitcher, NavItem, ScopePicker, SidebarItem, Tabs |
| Feedback | `components/feedback/` | Dialog, Toast, Tooltip, Spinner, EmptyState |
| Agent | `components/agent/` | Composer, Message, ToolCall, StepGroup, PullRequestCard, SessionRow, RunState, DiffBlock |
| Icon | `components/icon/` | Icon (Lucide wrapper — ported locally to `src/client/components/Icon.tsx`) |

The `agent/` group is the product's actual subject matter and maps closest to this app:

- **Composer** → `.composer` in `src/client/styles.css`
- **Message** → `.assistant-message` / `.user-message`
- **ToolCall** → `.timeline-event` and `.tool-message` (one line, borderless)
- **RunState** → `.run-state` in the conversation header
- **DiffBlock** → `.code-changes` / `.diff-view`
- **StepGroup** → not yet built here; collapses a run of activity lines behind one summary
- **PullRequestCard** → not yet built here; the one bordered card a thread earns
- **SessionRow** → `.session-button` in the sidebar

## Full-screen kits

`ui_kits/console/` is a working React console built on the system — `Shell.jsx`,
`Sessions.jsx`, `Session.jsx`, `NewSession.jsx`, `Ask.jsx`, `Settings.jsx`, `data.jsx`,
`index.html`. Read these for layout and composition questions ("how does the sidebar meet
the thread?", "what does the settings page look like?") rather than for single components.
