import { Icon } from "../components/Icon";

export function SimpleFeatures() {
  return (
    <section id="features" className="simple-section">
      <div className="simple-section-header">
        <span className="simple-kicker">WHY DEVELOPERS CHOOSE AITAR</span>
        <h2 className="simple-headline">Engineered for safety and trust</h2>
        <p className="simple-subtext">
          Text bots guess code. Aitar actually runs and tests it in the cloud.
        </p>
      </div>

      <div className="features-simple-grid">
        <div className="feature-simple-card">
          <div className="feature-card-icon">
            <Icon name="layers" size={20} />
          </div>
          <h3 className="feature-card-title">100% Isolated Cloud Sandboxes</h3>
          <p className="feature-card-desc">
            Every session boots into a fresh, firewalled Linux container. Code, commands, and packages
            run safely in the cloud without ever touching your personal laptop or RAM.
          </p>
        </div>

        <div className="feature-simple-card">
          <div className="feature-card-icon">
            <Icon name="globe" size={20} />
          </div>
          <h3 className="feature-card-title">Headless Browser Testing</h3>
          <p className="feature-card-desc">
            Aitar doesn&apos;t just guess that UI changes work. It spins up a headless Chromium
            browser, navigates your dev server, clicks elements, and verifies 0 console errors.
          </p>
        </div>

        <div className="feature-simple-card">
          <div className="feature-card-icon">
            <Icon name="folder-git-2" size={20} />
          </div>
          <h3 className="feature-card-title">Safe Git Checkpoints</h3>
          <p className="feature-card-desc">
            Every turn creates a safe internal checkpoint. You can review step-by-step diffs or roll
            back anytime with zero risk to your repository branches.
          </p>
        </div>
      </div>
    </section>
  );
}
