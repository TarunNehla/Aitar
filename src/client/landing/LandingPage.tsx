import { brandName } from "../auth/auth-copy";

export function LandingPage({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <main className="landing">
      <div className="landing-content">
        <div className="landing-hero">
          <div className="landing-brand">
            <img className="landing-logo" src="/logo.png" alt={brandName} />
            <span className="landing-name">{brandName}</span>
          </div>
          <h1 className="landing-headline">Your AI coding agent in&nbsp;the&nbsp;cloud</h1>
          <p className="landing-sub">
            Connect a GitHub repository, describe what you want, and watch an autonomous agent
            write code, run tests, and iterate — all in a sandboxed environment.
          </p>
          <button className="primary-button landing-cta" onClick={onGetStarted}>
            Get started
          </button>
        </div>

        <div className="landing-features">
          <div className="landing-feature">
            <div className="landing-feature-icon">&#x2692;</div>
            <h3>Sandboxed execution</h3>
            <p>Every session runs in an isolated Docker container with its own filesystem, shell, and browser.</p>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon">&#x1F517;</div>
            <h3>GitHub integration</h3>
            <p>Install the GitHub App, pick a repo, and the agent clones, branches, and pushes on your behalf.</p>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon">&#x1F4AC;</div>
            <h3>Conversational interface</h3>
            <p>Chat naturally. The agent shows its reasoning, tool calls, and terminal output as it works.</p>
          </div>
        </div>
      </div>
    </main>
  );
}
