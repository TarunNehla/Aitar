import { Icon } from "../components/Icon";
import { ProviderIcon } from "../components/ProviderIcon";

interface HeroSectionProps {
  onGetStarted: () => void;
}

const STACK_BADGES = [
  { label: "Docker Ephemeral Sandboxes", icon: "layers" as const },
  { label: "Chromium Headless Sidecar", icon: "globe" as const },
  { label: "Git Detached Checkpoints", icon: "folder-git-2" as const },
  { label: "Direct GitHub Pull Requests", icon: "git-pull-request" as const },
];

export function HeroSection({ onGetStarted }: HeroSectionProps) {
  return (
    <section className="landing-hero-section">
      <div className="landing-hero-pill">
        <span className="pill-tag">v0.9 BETA</span>
        <span className="pill-divider" />
        <span className="pill-text">Autonomous Cloud Coding &amp; Headless Chromium Sidecars</span>
      </div>

      <h1 className="landing-hero-title">
        Autonomous software engineering in isolated cloud sandboxes
      </h1>

      <p className="landing-hero-description">
        Connect your GitHub repository. Aitar spins up a dedicated Debian container with pre-warmed
        dev runtimes and headless Chromium. It edits code, runs test suites, validates UI flows
        in a real browser, and opens verified pull requests.
      </p>

      <div className="landing-hero-cta-group">
        <button className="landing-btn-primary" onClick={onGetStarted}>
          <span>Start Building Free</span>
          <Icon name="arrow-right" size={16} />
        </button>

        <a
          className="landing-btn-secondary"
          href="https://github.com/TarunNehla/Aitar"
          target="_blank"
          rel="noopener noreferrer"
        >
          <ProviderIcon provider="github" size={16} />
          <span>Star on GitHub</span>
        </a>
      </div>

      <div className="landing-stack-strip">
        <span className="stack-strip-label">ENGINEERED FOR MODERN REPOSITORIES</span>
        <div className="stack-badges">
          {STACK_BADGES.map((badge) => (
            <div key={badge.label} className="stack-badge-item">
              <Icon name={badge.icon} size={14} />
              <span>{badge.label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
