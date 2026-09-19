export function WorkflowSection() {
  return (
    <section id="workflow" className="section-container">
      <div className="section-header">
        <span className="section-kicker">Simple 3-Step Process</span>
        <h2 className="section-title">From prompt to merged pull request</h2>
        <p className="section-sub">
          Getting started takes under a minute. No CLI installation, no node version managers,
          no port forwarding.
        </p>
      </div>

      <div className="workflow-grid">
        <div className="workflow-card">
          <span className="workflow-step-badge">01</span>
          <h3 className="workflow-card-title">Connect Repository</h3>
          <p className="workflow-card-desc">
            Link your GitHub account or paste any public repository URL. Aitar creates a secure
            detached-HEAD workspace clone on the cloud host instantly.
          </p>
        </div>

        <div className="workflow-card">
          <span className="workflow-step-badge">02</span>
          <h3 className="workflow-card-title">Prompt &amp; Watch Agent Run</h3>
          <p className="workflow-card-desc">
            Describe the bug fix, feature, or refactor. The agent edits code, spins up your local
            dev server, clicks UI elements in Chromium, and runs test suites.
          </p>
        </div>

        <div className="workflow-card">
          <span className="workflow-step-badge">03</span>
          <h3 className="workflow-card-title">Review Diff &amp; Ship PR</h3>
          <p className="workflow-card-desc">
            Inspect unified diffs, review browser screenshots, and trigger 1-click GitHub Pull
            Request creation complete with an automated summary.
          </p>
        </div>
      </div>
    </section>
  );
}
