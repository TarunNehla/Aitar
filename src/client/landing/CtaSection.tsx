import { Icon } from "../components/Icon";
import { ProviderIcon } from "../components/ProviderIcon";

interface CtaSectionProps {
  onGetStarted: () => void;
}

export function CtaSection({ onGetStarted }: CtaSectionProps) {
  return (
    <section className="section-container">
      <div className="landing-cta-banner">
        <h2 className="cta-banner-title">
          Ready to supercharge your engineering workflow?
        </h2>
        <p className="cta-banner-desc">
          Connect your GitHub repository, prompt the agent, and watch it write code, test UI in Chromium,
          and draft ready-to-merge pull requests in minutes.
        </p>

        <div className="landing-hero-cta-group" style={{ marginBottom: 0 }}>
          <button className="landing-cta-btn large accent" onClick={onGetStarted}>
            <span>Get Started in 30 Seconds</span>
            <Icon name="arrow-right" size={18} />
          </button>

          <a
            className="landing-hero-secondary-btn"
            href="https://github.com/TarunNehla/Aitar"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              background: "rgba(255, 255, 255, 0.08)",
              borderColor: "rgba(255, 255, 255, 0.15)",
              color: "#ffffff",
            }}
          >
            <ProviderIcon provider="github" size={18} />
            <span>Star on GitHub</span>
          </a>
        </div>

        <span style={{ fontSize: "12px", color: "#8c96a5" }}>
          No credit card required • Public beta access • Instant container sandboxes
        </span>
      </div>
    </section>
  );
}
