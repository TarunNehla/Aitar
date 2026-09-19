import { brandName } from "../auth/auth-copy";
import { ProviderIcon } from "../components/ProviderIcon";

interface LandingFooterProps {
  onGetStarted: () => void;
}

export function LandingFooter({ onGetStarted }: LandingFooterProps) {
  return (
    <footer className="minimal-footer">
      <div className="footer-inner-wrap">
        <div className="footer-brand-side">
          <div className="footer-logo-row">
            <img className="nav-logo" src="/logo.png" alt={brandName} />
            <span className="nav-title">{brandName}</span>
          </div>
          <p className="footer-tagline">
            Autonomous software engineering in isolated cloud sandboxes.
          </p>
        </div>

        <div className="footer-links-side">
          <a href="#how-it-works" className="footer-nav-link">
            How it works
          </a>
          <a href="#features" className="footer-nav-link">
            Features
          </a>
          <a
            href="https://github.com/TarunNehla/Aitar"
            target="_blank"
            rel="noopener noreferrer"
            className="footer-nav-link"
          >
            <ProviderIcon provider="github" size={16} />
            <span>GitHub</span>
          </a>
          <button className="footer-nav-btn" onClick={onGetStarted}>
            Launch Console
          </button>
        </div>
      </div>

      <div className="footer-copyright-bar">
        <span>&copy; {new Date().getFullYear()} {brandName}. All rights reserved.</span>
        <span>Open source cloud coding agent</span>
      </div>
    </footer>
  );
}
