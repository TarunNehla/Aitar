import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Camera,
  Check,
  CircleCheck,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  FileDiff,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Globe,
  Keyboard,
  Layers,
  Mail,
  MessageSquare,
  Mic,
  MoreHorizontal,
  MousePointerClick,
  PanelRightOpen,
  Paperclip,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Square,
  Terminal,
  X,
} from "lucide-react";

/**
 * The design system's house glyph set (readme.md ICONOGRAPHY), keyed by the same
 * kebab-case names the Claude Design project uses. The upstream Icon.jsx fetches
 * these from the lucide-static CDN; we resolve them from the lucide-react package
 * instead so nothing is fetched at runtime and no SVG is hand-authored here.
 * Adding a glyph means adding it upstream first, then extending this map.
 */
const glyphs = {
  "alert-triangle": AlertTriangle,
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  "arrow-up": ArrowUp,
  camera: Camera,
  check: Check,
  "circle-check": CircleCheck,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  clock: Clock,
  copy: Copy,
  eye: Eye,
  "eye-off": EyeOff,
  "external-link": ExternalLink,
  "file-diff": FileDiff,
  "folder-git-2": FolderGit2,
  "git-branch": GitBranch,
  "git-pull-request": GitPullRequest,
  globe: Globe,
  keyboard: Keyboard,
  layers: Layers,
  mail: Mail,
  "message-square": MessageSquare,
  mic: Mic,
  "more-horizontal": MoreHorizontal,
  "mouse-pointer-click": MousePointerClick,
  "panel-right-open": PanelRightOpen,
  paperclip: Paperclip,
  play: Play,
  plus: Plus,
  "rotate-ccw": RotateCcw,
  search: Search,
  settings: Settings,
  sparkles: Sparkles,
  square: Square,
  terminal: Terminal,
  x: X,
} as const;

export type IconName = keyof typeof glyphs;

/**
 * Sizes are always even so strokes stay crisp: 14 in dense rows and chips,
 * 16 in buttons and menus, 18 in the left rail, 20 for empty states and dialogs.
 */
export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: 14 | 16 | 18 | 20;
  className?: string;
}) {
  const Glyph = glyphs[name];
  return (
    <Glyph
      aria-hidden="true"
      className={className}
      size={size}
      strokeWidth={1.5}
      absoluteStrokeWidth
    />
  );
}
