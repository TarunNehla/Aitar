import { Icon } from "../components/Icon";
import { ProviderIcon } from "../components/ProviderIcon";

interface CtaSectionProps {
  onGetStarted: () => void;
}

export function CtaSection({ onGetStarted }: CtaSectionProps) {
  return (
    <section className="landing-cta-section">
      <div className="landing-cta-card">
        <h2 className="cta-headline">Start building with Aitar today</h2>
        <p className="cta-subhead">
          Run your first cloud agent session in seconds. Connect your GitHub repository,
          assign a feature or bug fix, and review the verified pull request.
        </p>

        <div className="cta-button-group">
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
            <span>View on GitHub</span>
          </a>
        </div>

        <div className="cta-perks-row">
          <span>✓ No credit card required</span>
          <span className="dot-sep">•</span>
          <span>✓ Ephemeral container sandboxes</span>
          <span className="dot-sep">•</span>
          <span>✓ Full headless browser sidecar</span>
        </div>
      </div>
    </section>
  );
}
