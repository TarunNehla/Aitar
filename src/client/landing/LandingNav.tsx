import { brandName } from "../auth/auth-copy";
import { Icon } from "../components/Icon";
import { ProviderIcon } from "../components/ProviderIcon";

interface LandingNavProps {
  onGetStarted: () => void;
}

export function LandingNav({ onGetStarted }: LandingNavProps) {
  return (
    <header className="landing-header">
      <div className="landing-nav-container">
        <div className="landing-brand-link" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
          <img className="landing-brand-logo" src="/logo.png" alt={brandName} />
          <span className="landing-brand-title">{brandName}</span>
          <span className="landing-badge accent">Beta</span>
        </div>

        <ul className="landing-nav-links">
          <li>
            <a className="landing-nav-link" href="#features">
              Features
            </a>
          </li>
          <li>
            <a className="landing-nav-link" href="#demo">
              Live Preview
            </a>
          </li>
          <li>
            <a className="landing-nav-link" href="#workflow">
              Workflow
            </a>
          </li>
          <li>
            <a className="landing-nav-link" href="#models">
              Models
            </a>
          </li>
          <li>
            <a className="landing-nav-link" href="#faq">
              FAQ
            </a>
          </li>
        </ul>

        <div className="landing-nav-actions">
          <a
            className="landing-github-button"
            href="https://github.com/TarunNehla/Aitar"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Star Aitar on GitHub"
          >
            <ProviderIcon provider="github" size={16} />
            <span>GitHub</span>
          </a>

          <button className="landing-login-btn" onClick={onGetStarted}>
            Sign In
          </button>

          <button className="landing-cta-btn" onClick={onGetStarted}>
            <span>Get Started</span>
            <Icon name="arrow-right" size={14} />
          </button>
        </div>
      </div>
    </header>
  );
}
