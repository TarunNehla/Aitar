import { useState } from "react";
import { Icon } from "../components/Icon";

type DemoTab = "browser" | "diff" | "terminal" | "pr";

interface TaskItem {
  id: string;
  title: string;
  branch: string;
  status: "verified" | "merged" | "running";
  diffStats: string;
}

const DEMO_TASKS: TaskItem[] = [
  {
    id: "task-1",
    title: "Implement dark mode tokens & verify in browser",
    branch: "feat/dark-mode-tokens",
    status: "verified",
    diffStats: "+38 -4",
  },
  {
    id: "task-2",
    title: "Fix session cookie SameSite attribute on Safari",
    branch: "fix/safari-cookie-samesite",
    status: "merged",
    diffStats: "+12 -2",
  },
  {
    id: "task-3",
    title: "Upgrade Vite & configure Vitest browser runner",
    branch: "chore/vite-upgrade",
    status: "merged",
    diffStats: "+84 -19",
  },
];

export function InteractiveDemo() {
  const [activeTab, setActiveTab] = useState<DemoTab>("browser");
  const [selectedTask, setSelectedTask] = useState<string>("task-1");
  const [isDarkPreview, setIsDarkPreview] = useState(true);

  return (
    <section id="demo" className="landing-demo-section">
      <div className="demo-header-intro">
        <span className="section-kicker">Live Agent Workbench</span>
        <h2 className="demo-headline">Watch the agent build, test, and ship</h2>
        <p className="demo-subhead">
          Every session runs inside an ephemeral container. The agent plans steps, edits code,
          interacts with a headless Chromium sidecar, and opens a GitHub Pull Request.
        </p>
      </div>

      <div className="demo-window">
        {/* Window Chrome Titlebar */}
        <div className="demo-titlebar">
          <div className="demo-dots">
            <span className="demo-dot" />
            <span className="demo-dot" />
            <span className="demo-dot" />
          </div>

          <div className="demo-titlebar-center">
            <Icon name="folder-git-2" size={14} />
            <span className="demo-workspace-path">aitar-cloud / workspace / session-8f19c4</span>
          </div>

          <div className="demo-titlebar-right">
            <div className="demo-model-indicator">
              <span className="model-status-indicator" />
              <span className="model-name">Claude 3.7 Sonnet</span>
              <span className="model-thinking-tag">Thinking: High</span>
            </div>
          </div>
        </div>

        {/* 3-Column Workbench */}
        <div className="demo-workbench-grid">
          {/* Column 1: Task Rail */}
          <aside className="demo-task-rail">
            <div className="task-rail-header">
              <span className="task-rail-title">Agent Sessions</span>
              <span className="task-rail-count">3 Active</span>
            </div>

            <div className="task-rail-list">
              {DEMO_TASKS.map((task) => (
                <button
                  key={task.id}
                  className={`task-rail-item ${selectedTask === task.id ? "selected" : ""}`}
                  onClick={() => setSelectedTask(task.id)}
                >
                  <div className="task-item-top">
                    <span className={`status-dot ${task.status}`} />
                    <span className="task-item-title">{task.title}</span>
                  </div>
                  <div className="task-item-meta">
                    <span className="task-item-branch">{task.branch}</span>
                    <span className="task-item-diff">{task.diffStats}</span>
                  </div>
                </button>
              ))}
            </div>

            <div className="task-rail-footer">
              <div className="container-status-pill">
                <Icon name="layers" size={14} />
                <span>Debian Container · 2 Cores · 4GB RAM</span>
              </div>
            </div>
          </aside>

          {/* Column 2: Agent Execution Stream */}
          <div className="demo-stream-col">
            <div className="stream-header">
              <span className="stream-title">Execution Timeline</span>
              <span className="stream-latency">Total: 1m 42s</span>
            </div>

            <div className="stream-content">
              {/* User Prompt */}
              <div className="stream-block prompt-block">
                <div className="stream-block-label">
                  <Icon name="message-square" size={14} />
                  <span>Instruction</span>
                </div>
                <p className="prompt-text">
                  Add a responsive dark mode toggle to the header. Persist preferences to localStorage
                  and verify in Chromium that CSS custom properties update without console errors.
                </p>
              </div>

              {/* Agent Plan */}
              <div className="stream-block reasoning-block">
                <div className="reasoning-badge">
                  <Icon name="sparkles" size={14} />
                  <span>Agent Reasoning (4s)</span>
                </div>
                <p className="reasoning-body">
                  1. Inspect <code>src/styles/tokens.css</code> for dark theme custom properties.<br />
                  2. Add toggle handler in <code>Header.tsx</code> with <code>localStorage</code> sync.<br />
                  3. Launch dev server on <code>:5173</code>, navigate Chromium sidecar, click toggle, and verify DOM class.
                </p>
              </div>

              {/* Action Log Entries */}
              <div className="stream-actions-list">
                <div className="action-row success">
                  <Icon name="circle-check" size={14} />
                  <span className="action-cmd">read_file: src/styles/tokens.css</span>
                  <span className="action-time">48ms</span>
                </div>

                <div className="action-row success">
                  <Icon name="circle-check" size={14} />
                  <span className="action-cmd">replace_file_content: Header.tsx</span>
                  <span className="action-time">112ms</span>
                </div>

                <div className="action-row success">
                  <Icon name="terminal" size={14} />
                  <span className="action-cmd">bash: pnpm test</span>
                  <span className="action-time">600 passed</span>
                </div>

                <div className="action-row sidecar">
                  <Icon name="globe" size={14} />
                  <span className="action-cmd">browser_navigate: http://localhost:5173</span>
                  <span className="action-time">200 OK</span>
                </div>

                <div className="action-row sidecar">
                  <Icon name="mouse-pointer-click" size={14} />
                  <span className="action-cmd">browser_click: [data-theme-toggle]</span>
                  <span className="action-time">DOM mutated</span>
                </div>

                <div className="action-row checkpoint">
                  <Icon name="git-pull-request" size={14} />
                  <span className="action-cmd">checkpoint: commit 8f19c4d (detached HEAD)</span>
                  <span className="action-time">saved</span>
                </div>
              </div>
            </div>
          </div>

          {/* Column 3: Live Inspector / Viewport */}
          <div className="demo-inspector-col">
            <div className="inspector-tabs">
              <button
                className={`inspector-tab ${activeTab === "browser" ? "active" : ""}`}
                onClick={() => setActiveTab("browser")}
              >
                <Icon name="globe" size={14} />
                <span>Chromium Sidecar</span>
              </button>
              <button
                className={`inspector-tab ${activeTab === "diff" ? "active" : ""}`}
                onClick={() => setActiveTab("diff")}
              >
                <Icon name="file-diff" size={14} />
                <span>Unified Diff</span>
              </button>
              <button
                className={`inspector-tab ${activeTab === "terminal" ? "active" : ""}`}
                onClick={() => setActiveTab("terminal")}
              >
                <Icon name="terminal" size={14} />
                <span>Container Shell</span>
              </button>
              <button
                className={`inspector-tab ${activeTab === "pr" ? "active" : ""}`}
                onClick={() => setActiveTab("pr")}
              >
                <Icon name="git-pull-request" size={14} />
                <span>GitHub PR</span>
              </button>
            </div>

            <div className="inspector-body">
              {activeTab === "browser" && (
                <div className="browser-sidecar-panel">
                  <div className="browser-chrome-bar">
                    <div className="browser-url-input">
                      <span className="lock-icon">🔒</span>
                      <span className="url-text">http://localhost:5173/dashboard</span>
                    </div>
                    <button
                      className="browser-interact-toggle"
                      onClick={() => setIsDarkPreview(!isDarkPreview)}
                      title="Click to test theme toggle in preview"
                    >
                      <Icon name="mouse-pointer-click" size={14} />
                      <span>Simulate Click</span>
                    </button>
                  </div>

                  <div className={`browser-mockup-viewport ${isDarkPreview ? "dark" : "light"}`}>
                    <div className="mock-site-nav">
                      <div className="mock-site-brand">
                        <div className="mock-logo" />
                        <span>Acme Analytics</span>
                      </div>
                      <button
                        className="mock-theme-btn"
                        onClick={() => setIsDarkPreview(!isDarkPreview)}
                      >
                        {isDarkPreview ? "🌙 Dark" : "☀️ Light"}
                      </button>
                    </div>

                    <div className="mock-site-content">
                      <div className="mock-stat-card">
                        <span className="mock-label">Total Cloud Runs</span>
                        <span className="mock-val">24,582</span>
                      </div>
                      <div className="mock-stat-card">
                        <span className="mock-label">DOM Render Status</span>
                        <span className="mock-badge-success">✓ 0 Errors</span>
                      </div>
                    </div>
                  </div>

                  <div className="browser-footer-status">
                    <span className="status-item">
                      <span className="green-dot" /> Sidecar Port: 9222 (CDP Active)
                    </span>
                    <span className="status-item">Console: 0 errors · 0 warnings</span>
                  </div>
                </div>
              )}

              {activeTab === "diff" && (
                <div className="diff-sidecar-panel">
                  <div className="diff-header-row">
                    <span className="diff-filename">src/styles/tokens.css</span>
                    <span className="diff-stats">+18 -2 lines</span>
                  </div>
                  <pre className="diff-pre-code">
                    <code>{`@@ -14,6 +14,14 @@
 :root {
   --bg-primary: #ffffff;
   --text-primary: #111827;
+  --border-subtle: #e5e7eb;
 }

+[data-theme="dark"] {
+  --bg-primary: #090a0f;
+  --text-primary: #f9fafb;
+  --border-subtle: #1f2937;
+}
+
 export function applyTheme(theme) {
-  document.body.className = theme;
+  document.documentElement.setAttribute("data-theme", theme);
+  localStorage.setItem("aitar-theme", theme);
 }`}</code>
                  </pre>
                </div>
              )}

              {activeTab === "terminal" && (
                <div className="terminal-sidecar-panel">
                  <pre className="terminal-pre-code">
                    <code>{`$ docker exec -it aitar-session-8f19c4 bash
root@sandbox:/workspace# pnpm test

 ✓ src/client/app/__test__/App.test.tsx (48 tests)
 ✓ src/client/components/Icon.test.tsx (12 tests)
 ✓ src/auth/__test__/token.test.ts (14 tests)

 Test Files  38 passed (38)
      Tests  600 passed (600)
   Start at  13:08:42
   Duration  840ms (transform 120ms, setup 42ms, collect 380ms, tests 298ms)

root@sandbox:/workspace# pnpm run build
✓ 142 modules transformed.
dist/assets/index-BzxmhHUl.js   342.18 kB │ gzip: 104.22 kB
✓ built in 910ms`}</code>
                  </pre>
                </div>
              )}

              {activeTab === "pr" && (
                <div className="pr-sidecar-panel">
                  <div className="pr-top-bar">
                    <span className="pr-state-badge">Open</span>
                    <span className="pr-ref">TarunNehla:feat/dark-mode-tokens into main</span>
                  </div>
                  <h4 className="pr-subject">feat: implement dark mode tokens &amp; test browser DOM</h4>
                  <div className="pr-summary-box">
                    <p><strong>Automated Agent Summary:</strong></p>
                    <ul>
                      <li>Added <code>[data-theme="dark"]</code> CSS custom properties to <code>tokens.css</code>.</li>
                      <li>Added client theme persistence to <code>localStorage</code>.</li>
                      <li>Verified responsive layout and DOM attribute mutations via Chromium sidecar.</li>
                    </ul>
                    <div className="pr-checks-status">
                      <Icon name="circle-check" size={14} />
                      <span>All 4 GitHub checks passed (CI, Lint, Typecheck, Chromium Screencast)</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
