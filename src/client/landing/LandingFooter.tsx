import { brandName } from "../auth/auth-copy";
import { ProviderIcon } from "../components/ProviderIcon";

interface LandingFooterProps {
  onGetStarted: () => void;
}

export function LandingFooter({ onGetStarted }: LandingFooterProps) {
  return (
    <footer className="landing-footer">
      <div className="footer-container">
        <div className="footer-top">
          <div className="footer-brand">
            <div className="footer-logo-row">
              <img className="landing-brand-logo" src="/logo.png" alt={brandName} />
              <span className="landing-brand-title">{brandName}</span>
              <span className="landing-badge accent">Beta</span>
            </div>
            <p className="footer-desc">
              Autonomous AI software engineer in an isolated cloud sandbox. Equipped with real Docker
              containers, headless Chromium browser, and direct GitHub Pull Request workflows.
            </p>
          </div>

          <div className="footer-links-grid">
            <div className="footer-column">
              <span className="footer-column-title">Product</span>
              <a className="footer-link" href="#demo">Workbench</a>
              <a className="footer-link" href="#architecture">Architecture</a>
              <a className="footer-link" href="#sidecar">Chromium Sidecar</a>
              <a className="footer-link" href="#models">Models</a>
              <a className="footer-link" href="#faq">FAQ</a>
            </div>

            <div className="footer-column">
              <span className="footer-column-title">Open Source</span>
              <a
                className="footer-link"
                href="https://github.com/TarunNehla/Aitar"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub Repository
              </a>
              <a
                className="footer-link"
                href="https://github.com/TarunNehla/Aitar/issues"
                target="_blank"
                rel="noopener noreferrer"
              >
                Report an Issue
              </a>
              <a
                className="footer-link"
                href="https://github.com/TarunNehla/Aitar/blob/main/README.md"
                target="_blank"
                rel="noopener noreferrer"
              >
                Architecture Docs
              </a>
            </div>

            <div className="footer-column">
              <span className="footer-column-title">Get Started</span>
              <button
                className="footer-link"
                onClick={onGetStarted}
                style={{ background: "none", border: "none", padding: 0, textAlign: "left" }}
              >
                Sign In
              </button>
              <button
                className="footer-link"
                onClick={onGetStarted}
                style={{ background: "none", border: "none", padding: 0, textAlign: "left" }}
              >
                Launch Console
              </button>
            </div>
          </div>
        </div>

        <div className="footer-bottom">
          <span>&copy; {new Date().getFullYear()} {brandName}. All rights reserved.</span>
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <a
              href="https://github.com/TarunNehla/Aitar"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "inherit", display: "inline-flex", alignItems: "center", gap: "6px" }}
            >
              <ProviderIcon provider="github" size={16} />
              <span>Open Source on GitHub</span>
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
