import { useState } from "react";
import { Icon } from "../components/Icon";

type DemoTab = "browser" | "diff" | "terminal" | "pr";

export function InteractiveDemo() {
  const [activeTab, setActiveTab] = useState<DemoTab>("browser");
  const [isDarkMode, setIsDarkMode] = useState(true);

  return (
    <section id="demo" className="landing-demo-section">
      <div className="demo-window">
        {/* Window Chrome */}
        <div className="demo-titlebar">
          <div className="demo-dots">
            <span className="demo-dot red" />
            <span className="demo-dot yellow" />
            <span className="demo-dot green" />
          </div>
          <div className="demo-titlebar-title">
            <Icon name="folder-git-2" size={14} />
            <span>aitar-agent / workspace / session-e8f9a2</span>
          </div>
          <div className="demo-titlebar-meta">
            <div className="demo-model-chip">
              <Icon name="sparkles" size={14} />
              <span>Claude 3.7 Sonnet (Thinking: High)</span>
            </div>
          </div>
        </div>

        {/* Workbench Body */}
        <div className="demo-body">
          {/* Left: Chat & Action Timeline */}
          <div className="demo-chat-pane">
            <div className="demo-message">
              <div className="demo-message-header">
                <Icon name="message-square" size={14} />
                <span>Developer Instruction</span>
              </div>
              <div className="demo-user-bubble">
                Add a responsive dark mode toggle to the header, persist preference in localStorage,
                and verify it switches color tokens properly in Chromium.
              </div>
            </div>

            <div className="demo-assistant-reasoning">
              <strong>Thinking:</strong> Inspecting <code>src/components/Header.tsx</code> and CSS tokens.
              Need to add the toggle component, verify CSS variables, spawn the Vite server on port 5173,
              and navigate the Chromium sidecar to validate visual changes.
            </div>

            <div className="demo-tool-chips">
              <div className="demo-tool-chip">
                <div className="demo-tool-chip-name success">
                  <Icon name="circle-check" size={14} />
                  <span>read: src/components/Header.tsx</span>
                </div>
                <span className="demo-tool-time">142 lines · 0.2s</span>
              </div>

              <div className="demo-tool-chip">
                <div className="demo-tool-chip-name success">
                  <Icon name="circle-check" size={14} />
                  <span>edit: src/styles/theme.css</span>
                </div>
                <span className="demo-tool-time">2 edits · +38 -4</span>
              </div>

              <div className="demo-tool-chip">
                <div className="demo-tool-chip-name success">
                  <Icon name="terminal" size={14} />
                  <span>bash: pnpm run dev</span>
                </div>
                <span className="demo-tool-time">listening :5173</span>
              </div>

              <div className="demo-tool-chip">
                <div className="demo-tool-chip-name browser">
                  <Icon name="globe" size={14} />
                  <span>browser_navigate: http://localhost:5173</span>
                </div>
                <span className="demo-tool-time">200 OK · 1.1s</span>
              </div>

              <div className="demo-tool-chip">
                <div className="demo-tool-chip-name browser">
                  <Icon name="mouse-pointer-click" size={14} />
                  <span>browser_click: “Toggle Theme”</span>
                </div>
                <span className="demo-tool-time">active · 0.4s</span>
              </div>

              <div className="demo-tool-chip">
                <div className="demo-tool-chip-name browser">
                  <Icon name="camera" size={14} />
                  <span>browser_screenshot: 1280 × 720</span>
                </div>
                <span className="demo-tool-time">validated</span>
              </div>

              <div className="demo-checkpoint-chip">
                <Icon name="git-pull-request" size={14} />
                <span>Checkpoint saved: commit 7b1d24e · 3 files changed</span>
              </div>
            </div>
          </div>

          {/* Right: Multi-tab Inspector */}
          <div className="demo-inspector-pane">
            <div className="demo-tabs-bar">
              <button
                className={`demo-tab-btn ${activeTab === "browser" ? "active" : ""}`}
                onClick={() => setActiveTab("browser")}
              >
                <Icon name="globe" size={14} />
                <span>Chromium Sidecar</span>
              </button>
              <button
                className={`demo-tab-btn ${activeTab === "diff" ? "active" : ""}`}
                onClick={() => setActiveTab("diff")}
              >
                <Icon name="file-diff" size={14} />
                <span>Git Diff</span>
              </button>
              <button
                className={`demo-tab-btn ${activeTab === "terminal" ? "active" : ""}`}
                onClick={() => setActiveTab("terminal")}
              >
                <Icon name="terminal" size={14} />
                <span>Sandbox Shell</span>
              </button>
              <button
                className={`demo-tab-btn ${activeTab === "pr" ? "active" : ""}`}
                onClick={() => setActiveTab("pr")}
              >
                <Icon name="git-pull-request" size={14} />
                <span>Pull Request</span>
              </button>
            </div>

            <div className="demo-tab-content">
              {activeTab === "browser" && (
                <div className="demo-browser-view">
                  <div className="demo-browser-address-bar">
                    <Icon name="globe" size={14} />
                    <span className="url">http://localhost:5173</span>
                    <span style={{ marginLeft: "auto", color: "#34d399" }}>● Connected to Dev Server</span>
                  </div>

                  <div
                    className="demo-browser-canvas"
                    style={{
                      background: isDarkMode ? "#12161c" : "#ffffff",
                      color: isDarkMode ? "#f3f4f6" : "#111827",
                      transition: "all 0.3s ease",
                    }}
                  >
                    <div
                      className="mock-app-header"
                      style={{ borderBottomColor: isDarkMode ? "#28303d" : "#e5e7eb" }}
                    >
                      <span
                        className="mock-app-logo"
                        style={{ color: isDarkMode ? "#ffffff" : "#0f172a" }}
                      >
                        ⚡ Cloud App Preview
                      </span>
                      <button
                        className="mock-app-theme-btn"
                        onClick={() => setIsDarkMode(!isDarkMode)}
                        title="Click to toggle simulated theme"
                      >
                        <Icon name={isDarkMode ? "eye" : "eye-off"} size={14} />
                        <span>{isDarkMode ? "Dark Mode: Active" : "Light Mode: Active"}</span>
                      </button>
                    </div>

                    <div className="mock-app-cards">
                      <div
                        className="mock-card"
                        style={{
                          background: isDarkMode ? "#1a212b" : "#f9fafb",
                          borderColor: isDarkMode ? "#2d3644" : "#e5e7eb",
                        }}
                      >
                        <div
                          className="mock-card-title"
                          style={{ color: isDarkMode ? "#e5e7eb" : "#1f2937" }}
                        >
                          User Authentication
                        </div>
                        <div
                          className="mock-card-desc"
                          style={{ color: isDarkMode ? "#9ca3af" : "#6b7280" }}
                        >
                          Google &amp; GitHub OAuth linked via Better Auth.
                        </div>
                      </div>

                      <div
                        className="mock-card"
                        style={{
                          background: isDarkMode ? "#1a212b" : "#f9fafb",
                          borderColor: isDarkMode ? "#2d3644" : "#e5e7eb",
                        }}
                      >
                        <div
                          className="mock-card-title"
                          style={{ color: isDarkMode ? "#e5e7eb" : "#1f2937" }}
                        >
                          Isolated Sandbox
                        </div>
                        <div
                          className="mock-card-desc"
                          style={{ color: isDarkMode ? "#9ca3af" : "#6b7280" }}
                        >
                          Node 22 runtime inside Docker container.
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        marginTop: "auto",
                        padding: "8px 12px",
                        background: isDarkMode ? "#1e293b" : "#f1f5f9",
                        borderRadius: "6px",
                        fontSize: "11px",
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      <span style={{ color: "#10b981", display: "inline-flex" }}>
                        <Icon name="circle-check" size={14} />
                      </span>
                      <span>Chromium verified: Zero console errors on theme change.</span>
                    </div>
                  </div>

                  <div className="demo-browser-footer">
                    <span>Viewport: 1280 × 720 (High DPI)</span>
                    <span>Sidecar: aitar-browser:chromium</span>
                  </div>
                </div>
              )}

              {activeTab === "diff" && (
                <div className="demo-diff-view">
                  <span className="diff-line header">diff --git a/src/components/Header.tsx b/src/components/Header.tsx</span>
                  <span className="diff-line header">--- a/src/components/Header.tsx</span>
                  <span className="diff-line header">+++ b/src/components/Header.tsx</span>
                  <span className="diff-line ctx">@@ -14,6 +14,14 @@ export function Header() &#123;</span>
                  <span className="diff-line del">-  return &lt;header className="navbar"&gt;</span>
                  <span className="diff-line add">+  const [theme, setTheme] = useState(getStoredTheme);</span>
                  <span className="diff-line add">+</span>
                  <span className="diff-line add">+  const toggleTheme = () =&gt; &#123;</span>
                  <span className="diff-line add">+    const next = theme === "dark" ? "light" : "dark";</span>
                  <span className="diff-line add">+    setTheme(next);</span>
                  <span className="diff-line add">+    document.documentElement.setAttribute("data-theme", next);</span>
                  <span className="diff-line add">+  &#125;;</span>
                  <span className="diff-line add">+</span>
                  <span className="diff-line add">+  return (</span>
                  <span className="diff-line ctx">     &lt;header className="navbar"&gt;</span>
                  <span className="diff-line ctx">       &lt;Brand /&gt;</span>
                  <span className="diff-line add">+      &lt;ThemeToggle theme=&#123;theme&#125; onToggle=&#123;toggleTheme&#125; /&gt;</span>
                  <span className="diff-line ctx">     &lt;/header&gt;</span>
                </div>
              )}

              {activeTab === "terminal" && (
                <div className="demo-terminal-view">
                  <span className="term-line dim"># Connected to container node:22-bookworm at /workspace</span>
                  <span className="term-line cmd">$ pnpm test</span>
                  <span className="term-line">✓ src/components/__test__/Header.test.tsx (3 tests) 42ms</span>
                  <span className="term-line">✓ src/styles/__test__/tokens.test.ts (8 tests) 19ms</span>
                  <span className="term-line info">Test Files  2 passed (2)</span>
                  <span className="term-line info">Tests  11 passed (11)</span>
                  <span className="term-line cmd">$ git status --short</span>
                  <span className="term-line">M  src/components/Header.tsx</span>
                  <span className="term-line">M  src/styles/theme.css</span>
                  <span className="term-line">A  src/components/ThemeToggle.tsx</span>
                  <span className="term-line cmd">$ git commit -m "feat: add responsive dark mode toggle with browser test"</span>
                  <span className="term-line info">[detached-HEAD 7b1d24e] feat: add responsive dark mode toggle with browser test</span>
                  <span className="term-line dim"> 3 files changed, 48 insertions(+), 6 deletions(-)</span>
                </div>
              )}

              {activeTab === "pr" && (
                <div className="demo-pr-view">
                  <div className="pr-header">
                    <div>
                      <div className="pr-title">feat: add responsive dark mode toggle with localStorage persistence #42</div>
                      <div className="pr-meta">
                        <span>Branch: <code>aitar/dark-mode-toggle</code></span>
                        <span>•</span>
                        <span>Base: <code>main</code></span>
                      </div>
                    </div>
                    <span className="pr-badge">
                      <Icon name="check" size={14} />
                      Open PR
                    </span>
                  </div>

                  <div className="pr-body">
                    <strong>Summary:</strong>
                    <p style={{ margin: "6px 0 12px" }}>
                      This PR introduces a dark mode toggle button in the header component. Theme state
                      is persisted in localStorage and synchronizes with system preference on first load.
                    </p>
                    <strong>Automated Verification:</strong>
                    <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
                      <li>Chromium browser navigated dev server and validated UI theme switch.</li>
                      <li>Zero console errors reported during runtime tests.</li>
                      <li>Unit test suite passed (11 tests).</li>
                    </ul>
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
