import { Icon } from "../components/Icon";

interface SimpleCtaProps {
  onGetStarted: () => void;
}

export function SimpleCta({ onGetStarted }: SimpleCtaProps) {
  return (
    <section className="simple-cta-section">
      <div className="simple-cta-box">
        <h2 className="simple-cta-title">Ready to build with Aitar?</h2>
        <p className="simple-cta-sub">
          Connect your GitHub repository and watch Aitar code, test, and ship your next feature.
        </p>
        <button className="landing-btn-hero primary" onClick={onGetStarted}>
          <span>Start Building Free</span>
          <Icon name="arrow-right" size={16} />
        </button>
        <div className="cta-trust-note">
          <span>Free public beta • No credit card required • Instant setup</span>
        </div>
      </div>
    </section>
  );
}
