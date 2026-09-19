export function SimpleWorkflow() {
  return (
    <section id="how-it-works" className="simple-section">
      <div className="simple-section-header">
        <span className="simple-kicker">HOW IT WORKS</span>
        <h2 className="simple-headline">From prompt to pull request in minutes</h2>
        <p className="simple-subtext">
          No complicated setups. Aitar works directly with your existing GitHub workflow.
        </p>
      </div>

      <div className="workflow-steps-grid">
        <div className="workflow-step-card">
          <div className="step-number-badge">1</div>
          <h3 className="step-card-title">Connect your repo</h3>
          <p className="step-card-text">
            Link your GitHub repository. Aitar automatically detects your package manager,
            build scripts, and dev server.
          </p>
        </div>

        <div className="workflow-step-card">
          <div className="step-number-badge">2</div>
          <h3 className="step-card-title">Describe what you need</h3>
          <p className="step-card-text">
            Prompt Aitar in plain English. The agent inspects code, edits files, and tests
            everything in a live Chromium browser.
          </p>
        </div>

        <div className="workflow-step-card">
          <div className="step-number-badge">3</div>
          <h3 className="step-card-title">Review and merge</h3>
          <p className="step-card-text">
            Aitar opens a clean Pull Request with verified browser screenshots, test results,
            and diffs. Just review and merge.
          </p>
        </div>
      </div>
    </section>
  );
}
