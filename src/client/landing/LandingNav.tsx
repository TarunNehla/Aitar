import { brandName } from "../auth/auth-copy";
import { Icon } from "../components/Icon";
import { ProviderIcon } from "../components/ProviderIcon";

interface LandingNavProps {
  onGetStarted: () => void;
}

export function LandingNav({ onGetStarted }: LandingNavProps) {
  return (
    <header className="minimal-header">
      <div className="minimal-nav-wrap">
        <div className="nav-brand" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
          <img className="nav-logo" src="/logo.png" alt={brandName} />
          <span className="nav-title">{brandName}</span>
          <span className="nav-beta-tag">Beta</span>
        </div>

        <nav className="nav-links">
          <a className="nav-link" href="#how-it-works">
            How it works
          </a>
          <a className="nav-link" href="#features">
            Features
          </a>
          <a
            className="nav-link github-link"
            href="https://github.com/TarunNehla/Aitar"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ProviderIcon provider="github" size={16} />
            <span>GitHub</span>
          </a>
        </nav>

        <div className="nav-actions">
          <button className="nav-signin-btn" onClick={onGetStarted}>
            Sign In
          </button>
          <button className="nav-get-started-btn" onClick={onGetStarted}>
            <span>Get Started</span>
            <Icon name="arrow-right" size={14} />
          </button>
        </div>
      </div>
    </header>
  );
}
