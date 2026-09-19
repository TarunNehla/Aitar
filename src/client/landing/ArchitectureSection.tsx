import { Icon } from "../components/Icon";

export function ArchitectureSection() {
  return (
    <section id="architecture" className="landing-arch-section">
      <div className="section-header-centered">
        <span className="section-kicker">Engineered For Reliability</span>
        <h2 className="section-headline">Why autonomous coding requires cloud infrastructure</h2>
        <p className="section-subtext">
          Text-only chatbots hallucinate code they cannot execute. Local CLI agents risk arbitrary
          execution on your personal computer. Aitar combines isolated Linux containers with a live
          headless browser to guarantee code actually runs.
        </p>
      </div>

      <div className="arch-pillars-grid">
        {/* Pillar 1: Cloud Sandboxes */}
        <div className="arch-card">
          <div className="arch-card-header">
            <div className="arch-badge-icon">
              <Icon name="layers" size={18} />
            </div>
            <span className="arch-step-tag">CONTAINER ISOLATION</span>
          </div>

          <h3 className="arch-card-title">Ephemeral Debian Sandboxes</h3>
          <p className="arch-card-text">
            Every session boots inside a dedicated, firewalled Docker container. Packages install in
            isolation, background dev servers run on independent ports, and your personal workstation
            is never exposed to untested dependencies or dangerous shell commands.
          </p>

          <div className="arch-code-preview">
            <div className="code-preview-bar">
              <span className="code-preview-file">sandbox-spec.json</span>
            </div>
            <pre className="arch-code-body">
              <code>{`{
  "runtime": "debian-12-bookworm",
  "limits": { "cpus": 2, "memory": "4096MB" },
  "isolation": "cgroups-v2 + seccomp",
  "storage": "ephemeral-overlay2",
  "network": "isolated-bridge-dns"
}`}</code>
            </pre>
          </div>
        </div>

        {/* Pillar 2: Chromium Sidecar */}
        <div className="arch-card" id="sidecar">
          <div className="arch-card-header">
            <div className="arch-badge-icon">
              <Icon name="globe" size={18} />
            </div>
            <span className="arch-step-tag">BROWSER VERIFICATION</span>
          </div>

          <h3 className="arch-card-title">Headless Chromium Sidecar</h3>
          <p className="arch-card-text">
            Frontend code cannot be verified by unit tests alone. Aitar connects directly to a headless
            Chromium instance over Chrome DevTools Protocol. The agent navigates your local dev server,
            clicks buttons, inspects DOM elements, and reads console logs before committing.
          </p>

          <div className="arch-code-preview">
            <div className="code-preview-bar">
              <span className="code-preview-file">agent-cdp-session.ts</span>
            </div>
            <pre className="arch-code-body">
              <code>{`await sidecar.navigate("http://localhost:5173");
await sidecar.click("[data-testid='filter-active']");
const errors = await sidecar.getConsoleErrors();
expect(errors.length).toBe(0); // verified!`}</code>
            </pre>
          </div>
        </div>

        {/* Pillar 3: Git Checkpoints */}
        <div className="arch-card">
          <div className="arch-card-header">
            <div className="arch-badge-icon">
              <Icon name="folder-git-2" size={18} />
            </div>
            <span className="arch-step-tag">TURN-BY-TURN SAFETY</span>
          </div>

          <h3 className="arch-card-title">Deterministic Git Checkpoints</h3>
          <p className="arch-card-text">
            Every single agent turn creates a detached internal Git commit. If an LLM explores an
            unproductive solution or introduces a subtle regression, you can inspect the exact diff
            and roll back state with one click.
          </p>

          <div className="arch-code-preview">
            <div className="code-preview-bar">
              <span className="code-preview-file">git-checkpoint-log</span>
            </div>
            <pre className="arch-code-body">
              <code>{`* 8f19c4d (HEAD -> aitar/feat-tokens) turn 3: browser DOM verified
* 7b1d24e turn 2: pnpm test passes (600/600)
* 4a9f10b turn 1: update tokens.css
* 1b08b2a (origin/main) initial repository clone`}</code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
