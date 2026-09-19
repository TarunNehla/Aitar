import { Icon } from "../components/Icon";
import { ProviderIcon } from "../components/ProviderIcon";
import { InteractivePlayground } from "./InteractivePlayground";

interface HeroSectionProps {
  onGetStarted: () => void;
}

export function HeroSection({ onGetStarted }: HeroSectionProps) {
  return (
    <section className="minimal-hero-section">
      <div className="hero-announcement-pill">
        <span className="pill-dot" />
        <span>Autonomous software engineering in isolated cloud sandboxes</span>
      </div>

      <h1 className="hero-main-title">
        Describe what to build.<br />
        Aitar codes, tests, and ships.
      </h1>

      <p className="hero-main-subtext">
        Connect your GitHub repository. Aitar runs in a secure cloud container with a real
        headless browser, verifies its changes, and opens clean pull requests.
      </p>

      <div className="hero-actions-row">
        <button className="landing-btn-hero primary" onClick={onGetStarted}>
          <span>Start Building Free</span>
          <Icon name="arrow-right" size={16} />
        </button>

        <a
          className="landing-btn-hero secondary"
          href="https://github.com/TarunNehla/Aitar"
          target="_blank"
          rel="noopener noreferrer"
        >
          <ProviderIcon provider="github" size={16} />
          <span>Star on GitHub</span>
        </a>
      </div>

      {/* Interactive Prompt Playground */}
      <InteractivePlayground />
    </section>
  );
}
