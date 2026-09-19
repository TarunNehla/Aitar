import { useState } from "react";
import { Icon } from "../components/Icon";

interface FaqItem {
  question: string;
  answer: string;
}

const faqItems: FaqItem[] = [
  {
    question: "How does Aitar run code safely without risking my machine?",
    answer:
      "Every chat session boots into a completely isolated Docker container (`node:22-bookworm`) hosted on our cloud VPS. Sandboxes run with bounded CPU and memory limits, non-root user permissions, and strict timeouts. Zero commands are executed on your local computer.",
  },
  {
    question: "Can I connect private repositories?",
    answer:
      "Yes. You can link your GitHub account and install our official GitHub App. You choose exactly which private repositories Aitar has access to. Aitar securely fetches the code, branches off, and opens pull requests on your behalf.",
  },
  {
    question: "How does the Chromium browser sidecar work?",
    answer:
      "When the agent starts a local dev server (like Vite or Next.js), Aitar automatically starts an attached Chromium container on a private bridge network. The agent uses autonomous tools to navigate the app, click buttons, submit forms, inspect browser console logs, and capture full-resolution screenshots.",
  },
  {
    question: "What happens to git history during a session?",
    answer:
      "Aitar works on a detached-HEAD checkout. After every assistant turn, an automated checkpoint commit is recorded. You can inspect the diffs live, download standard patch files, or push a clean branch to GitHub with 1-click Pull Request generation.",
  },
  {
    question: "Can I adjust the model's thinking depth?",
    answer:
      "Yes. For reasoning models like Claude 3.7 Sonnet, you can configure the thinking budget (Off, Low, Medium, High). Use lower budgets for simple edits and higher budgets for complex architecture decisions.",
  },
  {
    question: "Is there any local CLI or dependency setup needed?",
    answer:
      "None. Aitar is 100% browser-based. All package installations, Docker daemon bindings, and headless browser processes happen entirely within cloud infrastructure.",
  },
];

export function FaqSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const toggle = (index: number) => {
    setOpenIndex((current) => (current === index ? null : index));
  };

  return (
    <section id="faq" className="section-container">
      <div className="section-header">
        <span className="section-kicker">Answers &amp; Details</span>
        <h2 className="section-title">Frequently asked questions</h2>
        <p className="section-sub">
          Everything you need to know about Aitar&apos;s cloud architecture and security model.
        </p>
      </div>

      <div className="faq-list">
        {faqItems.map((item, index) => {
          const isOpen = openIndex === index;
          return (
            <div key={item.question} className="faq-item">
              <button
                className="faq-question"
                onClick={() => toggle(index)}
                aria-expanded={isOpen}
              >
                <span>{item.question}</span>
                <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={16} />
              </button>
              {isOpen && <div className="faq-answer">{item.answer}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
