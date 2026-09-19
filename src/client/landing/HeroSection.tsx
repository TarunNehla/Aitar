import { Icon } from "../components/Icon";
import { ProviderIcon } from "../components/ProviderIcon";

interface HeroSectionProps {
  onGetStarted: () => void;
}

export function HeroSection({ onGetStarted }: HeroSectionProps) {
  return (
    <section className="landing-hero-section">
      <div className="landing-hero-pill">
        <span className="dot" aria-hidden="true" />
        <span>Now Live: Hybrid Reasoning &amp; Chromium Sidecar</span>
      </div>

      <h1 className="landing-hero-title">
        The autonomous cloud coding agent that{" "}
        <span className="landing-hero-title-highlight">actually runs your code</span>
      </h1>

      <p className="landing-hero-description">
        Connect your GitHub repository. Aitar spins up an isolated Docker container with a detached
        Git environment and headless Chromium. It writes code, navigates dev servers, tests UI flows,
        and drafts ready-to-merge Pull Requests.
      </p>

      <div className="landing-hero-cta-group">
        <button className="landing-cta-btn large accent" onClick={onGetStarted}>
          <span>Start Coding Free</span>
          <Icon name="arrow-right" size={18} />
        </button>

        <a
          className="landing-hero-secondary-btn"
          href="https://github.com/TarunNehla/Aitar"
          target="_blank"
          rel="noopener noreferrer"
        >
          <ProviderIcon provider="github" size={18} />
          <span>Star on GitHub</span>
        </a>
      </div>

      <div className="landing-hero-guarantees">
        <div className="landing-hero-guarantee">
          <Icon name="circle-check" size={14} />
          <span>Isolated Linux Containers</span>
        </div>
        <div className="landing-hero-guarantee">
          <Icon name="circle-check" size={14} />
          <span>Automated Headless Browser</span>
        </div>
        <div className="landing-hero-guarantee">
          <Icon name="circle-check" size={14} />
          <span>Direct GitHub PR Generation</span>
        </div>
      </div>
    </section>
  );
}
