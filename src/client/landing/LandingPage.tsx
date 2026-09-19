import "./landing.css";
import { brandName } from "../auth/auth-copy";
import { Icon } from "../components/Icon";
import { ProviderIcon } from "../components/ProviderIcon";

interface LandingPageProps {
  onGetStarted: () => void;
}

const workflow = [
  {
    number: "01",
    title: "Connect a repository",
    description: "Choose a GitHub repository and Aitar prepares a private cloud workspace.",
  },
  {
    number: "02",
    title: "Describe the change",
    description: "Ask for a feature, a fix, or an investigation in plain English.",
  },
  {
    number: "03",
    title: "Review the result",
    description: "Follow the work, inspect the code, and open a pull request when it is ready.",
  },
];

const capabilities = [
  "Runs commands in an isolated container",
  "Reads and edits your repository",
  "Tests changes in a real browser",
  "Keeps every chat on its own branch",
];

export function LandingPage({ onGetStarted }: LandingPageProps) {
  return (
    <div className="landing-page">
      <header className="landing-header">
        <a className="landing-brand" href="#top" aria-label={`${brandName} home`}>
          <img src="/logo.png" alt="" />
          <span>{brandName}</span>
        </a>

        <div className="landing-header-actions">
          <a
            className="landing-github-link"
            href="https://github.com/TarunNehla/Aitar"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ProviderIcon provider="github" size={16} />
            <span>GitHub</span>
          </a>
          <button className="landing-sign-in" onClick={onGetStarted}>
            Sign in
          </button>
        </div>
      </header>

      <main id="top">
        <section className="landing-hero" aria-labelledby="landing-title">
          <p className="landing-eyebrow">Cloud coding agent</p>
          <h1 id="landing-title">A coding agent that works in the cloud.</h1>
          <p className="landing-intro">
            Give Aitar a task. It opens your repository in a private workspace, writes the code,
            runs the tests, and prepares the change for review.
          </p>

          <div className="landing-hero-actions">
            <button className="landing-primary-action" onClick={onGetStarted}>
              Start with GitHub
              <Icon name="arrow-right" size={16} />
            </button>
            <a className="landing-text-link" href="#how-it-works">
              See how it works
            </a>
          </div>

          <div className="landing-example" aria-label="Example task">
            <div className="landing-example-header">
              <span className="landing-example-dot" />
              <span>Example task</span>
            </div>
            <p>“Add account settings, test the form, and open a pull request.”</p>
            <div className="landing-example-status">
              <span>Repository connected</span>
              <span>Code updated</span>
              <span>Tests passed</span>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="landing-section landing-workflow">
          <div className="landing-section-heading">
            <p className="landing-eyebrow">How it works</p>
            <h2>From request to pull request.</h2>
          </div>

          <div className="landing-workflow-list">
            {workflow.map((step) => (
              <article className="landing-workflow-step" key={step.number}>
                <span>{step.number}</span>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section landing-capabilities">
          <div className="landing-capability-copy">
            <p className="landing-eyebrow">Built for real work</p>
            <h2>Your repository stays separate from your computer.</h2>
            <p>
              Each chat gets its own branch and workspace. Aitar can work independently without
              using your local files or interrupting your machine.
            </p>
          </div>

          <ul className="landing-capability-list">
            {capabilities.map((capability) => (
              <li key={capability}>
                <Icon name="circle-check" size={18} />
                <span>{capability}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing-final-cta">
          <h2>Start with one repository.</h2>
          <p>Connect GitHub and ask Aitar to make your first change.</p>
          <button className="landing-primary-action" onClick={onGetStarted}>
            Get started
            <Icon name="arrow-right" size={16} />
          </button>
        </section>
      </main>

      <footer className="landing-footer">
        <span>© {new Date().getFullYear()} {brandName}</span>
        <span>Open source cloud coding agent</span>
      </footer>
    </div>
  );
}
