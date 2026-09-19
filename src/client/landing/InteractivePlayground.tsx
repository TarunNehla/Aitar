import { useState } from "react";
import { Icon } from "../components/Icon";

interface PresetTask {
  id: string;
  tag: string;
  label: string;
  prompt: string;
  filesChanged: string;
  diffCode: string;
  previewTitle: string;
  previewDescription: string;
}

const PRESET_TASKS: PresetTask[] = [
  {
    id: "dark-mode",
    tag: "🌙 Theme",
    label: "Dark Mode Toggle",
    prompt: "Add a responsive dark mode toggle to the header and persist preferences in localStorage.",
    filesChanged: "src/styles/theme.css (+14, -2)",
    diffCode: `+ [data-theme="dark"] {
+   --bg-primary: #0a0b0e;
+   --text-primary: #f8fafc;
+   --border: rgba(255, 255, 255, 0.1);
+ }
  export function toggleTheme() {
-   document.body.classList.toggle("dark");
+   const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
+   document.documentElement.dataset.theme = next;
+   localStorage.setItem("theme", next);
  }`,
    previewTitle: "Acme Dashboard",
    previewDescription: "Click the toggle button below to test the agent's implementation live:",
  },
  {
    id: "oauth",
    tag: "🔒 Auth",
    label: "GitHub OAuth",
    prompt: "Implement GitHub OAuth login flow with secure session cookie handling.",
    filesChanged: "src/server/auth/github.ts (+22, -4)",
    diffCode: `+ export async function handleGitHubCallback(code: string) {
+   const token = await exchangeCodeForToken(code);
+   const profile = await fetchGitHubUser(token);
+   const session = await createSession(profile.id);
+   return setSessionCookie(session.token);
+ }`,
    previewTitle: "Authentication Gate",
    previewDescription: "Click the button below to test the GitHub login flow:",
  },
  {
    id: "mobile-nav",
    tag: "📱 Layout",
    label: "Mobile Nav Drawer",
    prompt: "Fix mobile navigation drawer overlay and smooth slide-in transition on mobile viewports.",
    filesChanged: "src/components/Navigation.tsx (+18, -3)",
    diffCode: `+ export function MobileDrawer({ isOpen, onClose }: DrawerProps) {
+   return (
+     <div className={\`drawer-backdrop \${isOpen ? "visible" : ""}\`} onClick={onClose}>
+       <aside className={\`drawer-panel \${isOpen ? "open" : ""}\`}>
+         <nav className="drawer-links">...</nav>
+       </aside>
+     </div>
+   );
+ }`,
    previewTitle: "Mobile Navigation",
    previewDescription: "Click the menu toggle below to test the responsive drawer:",
  },
];

export function InteractivePlayground() {
  const [selectedTaskId, setSelectedTaskId] = useState<string>("dark-mode");
  const [activeView, setActiveView] = useState<"preview" | "diff">("preview");

  // Interactive state inside the preview
  const [isDarkTheme, setIsDarkTheme] = useState(true);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  const currentTask = PRESET_TASKS.find((t) => t.id === selectedTaskId) || PRESET_TASKS[0];

  const handleSelectTask = (id: string) => {
    setSelectedTaskId(id);
    setActiveView("preview");
  };

  return (
    <div className="playground-container">
      {/* Interactive Prompt Bar */}
      <div className="playground-prompt-box">
        <div className="prompt-input-row">
          <div className="prompt-icon">
            <Icon name="sparkles" size={18} />
          </div>
          <div className="prompt-display-text">
            <span className="prompt-quote">&ldquo;</span>
            <span>{currentTask.prompt}</span>
            <span className="prompt-quote">&rdquo;</span>
          </div>
        </div>

        {/* Clickable Preset Pills */}
        <div className="playground-preset-pills">
          <span className="preset-pill-label">Try an example:</span>
          <div className="preset-pill-group">
            {PRESET_TASKS.map((task) => (
              <button
                key={task.id}
                className={`preset-pill ${selectedTaskId === task.id ? "active" : ""}`}
                onClick={() => handleSelectTask(task.id)}
              >
                <span>{task.tag}</span>
                <span>{task.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Interactive Stage Card */}
      <div className="playground-stage-card">
        {/* Stage Header */}
        <div className="stage-card-header">
          <div className="stage-left-info">
            <span className="stage-dot" />
            <span className="stage-title">Aitar Cloud Workspace</span>
            <span className="stage-branch">branch: {selectedTaskId}-patch</span>
          </div>

          <div className="stage-view-toggle">
            <button
              className={`view-toggle-btn ${activeView === "preview" ? "active" : ""}`}
              onClick={() => setActiveView("preview")}
            >
              <Icon name="globe" size={14} />
              <span>Browser Preview</span>
            </button>
            <button
              className={`view-toggle-btn ${activeView === "diff" ? "active" : ""}`}
              onClick={() => setActiveView("diff")}
            >
              <Icon name="file-diff" size={14} />
              <span>Code Diff</span>
            </button>
          </div>
        </div>

        {/* Stage Content */}
        <div className="stage-card-body">
          {activeView === "preview" ? (
            <div className="stage-preview-layout">
              {/* Left Column: Simulated Browser Viewport */}
              <div className="simulated-browser-window">
                <div className="browser-header-strip">
                  <div className="browser-dots">
                    <span className="dot" />
                    <span className="dot" />
                    <span className="dot" />
                  </div>
                  <div className="browser-address">
                    <span>localhost:5173/{selectedTaskId}</span>
                  </div>
                  <span className="browser-badge-live">Live Sidecar</span>
                </div>

                {/* Mini App Content (interactive!) */}
                <div
                  className={`mini-app-canvas ${
                    selectedTaskId === "dark-mode" && !isDarkTheme ? "theme-light" : "theme-dark"
                  }`}
                >
                  <div className="mini-app-nav">
                    <span className="mini-app-logo">✦ {currentTask.previewTitle}</span>

                    {/* Dark Mode Interactive Control */}
                    {selectedTaskId === "dark-mode" && (
                      <button
                        className="interactive-action-btn"
                        onClick={() => setIsDarkTheme(!isDarkTheme)}
                      >
                        {isDarkTheme ? "🌙 Dark" : "☀️ Light"} (Click me)
                      </button>
                    )}

                    {/* Mobile Nav Interactive Control */}
                    {selectedTaskId === "mobile-nav" && (
                      <button
                        className="interactive-action-btn"
                        onClick={() => setIsDrawerOpen(!isDrawerOpen)}
                      >
                        {isDrawerOpen ? "✕ Close" : "☰ Menu"}
                      </button>
                    )}
                  </div>

                  <div className="mini-app-content">
                    <p className="mini-app-desc">{currentTask.previewDescription}</p>

                    {/* OAuth Interactive Control */}
                    {selectedTaskId === "oauth" && (
                      <div className="oauth-demo-box">
                        {isSignedIn ? (
                          <div className="signed-in-badge">
                            <Icon name="circle-check" size={16} />
                            <span>Signed in as <strong>@developer</strong></span>
                            <button
                              className="oauth-reset-btn"
                              onClick={() => setIsSignedIn(false)}
                            >
                              Sign out
                            </button>
                          </div>
                        ) : (
                          <button
                            className="github-login-demo-btn"
                            onClick={() => setIsSignedIn(true)}
                          >
                            <Icon name="folder-git-2" size={16} />
                            <span>Continue with GitHub</span>
                          </button>
                        )}
                      </div>
                    )}

                    {/* Mobile Drawer Overlay */}
                    {selectedTaskId === "mobile-nav" && isDrawerOpen && (
                      <div className="mini-drawer-open">
                        <span className="drawer-item">Home</span>
                        <span className="drawer-item">Projects</span>
                        <span className="drawer-item">Settings</span>
                        <span className="drawer-close" onClick={() => setIsDrawerOpen(false)}>
                          Tap to dismiss
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Right Column: Agent Verification Checklist */}
              <div className="stage-verification-panel">
                <span className="verification-header">AUTONOMOUS EXECUTION</span>

                <div className="verification-steps">
                  <div className="v-step done">
                    <div className="v-step-icon">✓</div>
                    <div className="v-step-text">
                      <strong>Environment Ready</strong>
                      <span>Ephemeral Debian sandbox booted (0.4s)</span>
                    </div>
                  </div>

                  <div className="v-step done">
                    <div className="v-step-icon">✓</div>
                    <div className="v-step-text">
                      <strong>Code Edits Applied</strong>
                      <span>{currentTask.filesChanged}</span>
                    </div>
                  </div>

                  <div className="v-step done">
                    <div className="v-step-icon">✓</div>
                    <div className="v-step-text">
                      <strong>Chromium Sidecar Verified</strong>
                      <span>Dev server rendered with 0 console errors</span>
                    </div>
                  </div>

                  <div className="v-step done ready">
                    <div className="v-step-icon">✓</div>
                    <div className="v-step-text">
                      <strong>Pull Request Ready</strong>
                      <span>Automated summary &amp; visual diff attached</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Diff View */
            <div className="stage-diff-view">
              <div className="diff-view-top">
                <span className="diff-file-label">{currentTask.filesChanged}</span>
                <span className="diff-verified-tag">✓ Tests Pass</span>
              </div>
              <pre className="diff-code-area">
                <code>{currentTask.diffCode}</code>
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
