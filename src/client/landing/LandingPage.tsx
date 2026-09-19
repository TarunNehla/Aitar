import "./landing.css";
import { LandingNav } from "./LandingNav";
import { HeroSection } from "./HeroSection";
import { SimpleWorkflow } from "./SimpleWorkflow";
import { SimpleFeatures } from "./SimpleFeatures";
import { SimpleCta } from "./SimpleCta";
import { LandingFooter } from "./LandingFooter";

interface LandingPageProps {
  onGetStarted: () => void;
}

export function LandingPage({ onGetStarted }: LandingPageProps) {
  return (
    <div className="minimal-landing-root">
      <LandingNav onGetStarted={onGetStarted} />
      <main className="landing-main-flow">
        <HeroSection onGetStarted={onGetStarted} />
        <SimpleWorkflow />
        <SimpleFeatures />
        <SimpleCta onGetStarted={onGetStarted} />
      </main>
      <LandingFooter onGetStarted={onGetStarted} />
    </div>
  );
}
