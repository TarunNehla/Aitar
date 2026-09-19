import "./landing.css";
import { LandingNav } from "./LandingNav";
import { HeroSection } from "./HeroSection";
import { InteractiveDemo } from "./InteractiveDemo";
import { MetricsStrip } from "./MetricsStrip";
import { FeaturesSection } from "./FeaturesSection";
import { WorkflowSection } from "./WorkflowSection";
import { ComparisonSection } from "./ComparisonSection";
import { ModelsSection } from "./ModelsSection";
import { FaqSection } from "./FaqSection";
import { CtaSection } from "./CtaSection";
import { LandingFooter } from "./LandingFooter";

interface LandingPageProps {
  onGetStarted: () => void;
}

export function LandingPage({ onGetStarted }: LandingPageProps) {
  return (
    <div className="landing-page">
      <LandingNav onGetStarted={onGetStarted} />
      <main>
        <HeroSection onGetStarted={onGetStarted} />
        <InteractiveDemo />
        <MetricsStrip />
        <FeaturesSection />
        <WorkflowSection />
        <ComparisonSection />
        <ModelsSection />
        <FaqSection />
        <CtaSection onGetStarted={onGetStarted} />
      </main>
      <LandingFooter onGetStarted={onGetStarted} />
    </div>
  );
}
