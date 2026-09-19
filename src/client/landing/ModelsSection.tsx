import { Icon } from "../components/Icon";

export function ModelsSection() {
  return (
    <section id="models" className="landing-models-section">
      <div className="section-header-centered">
        <span className="section-kicker">Frontier Intelligence</span>
        <h2 className="section-headline">Orchestrating the finest reasoning engines</h2>
        <p className="section-subtext">
          Different engineering tasks require different trade-offs between deep reasoning and raw speed.
          Aitar lets you route tasks to specialized frontier models via OpenRouter or bring your own API keys.
        </p>
      </div>

      <div className="models-grid">
        <div className="model-spec-card">
          <div className="model-spec-top">
            <div className="model-title-group">
              <span className="model-name">Claude 3.7 Sonnet</span>
              <span className="model-badge">Extended Thinking</span>
            </div>
          </div>
          <p className="model-spec-desc">
            Anthropic&apos;s premier coding model with toggleable reasoning budgets. Excels at complex
            architectural refactors, state management debugging, and multi-file migrations.
          </p>
          <div className="model-spec-meta">
            <span className="meta-tag">200k Context</span>
            <span className="meta-tag">Deep Code Logic</span>
            <span className="meta-tag">Granular Thinking</span>
          </div>
        </div>

        <div className="model-spec-card">
          <div className="model-spec-top">
            <div className="model-title-group">
              <span className="model-name">DeepSeek V3 / R1</span>
              <span className="model-badge">High Throughput</span>
            </div>
          </div>
          <p className="model-spec-desc">
            Ultra-fast inference optimized for rapid iterative loops, unit test generation, and
            quick code edits. Highly cost-effective for large repetitive codebases.
          </p>
          <div className="model-spec-meta">
            <span className="meta-tag">128k Context</span>
            <span className="meta-tag">Sub-second Latency</span>
            <span className="meta-tag">Cost-Efficient</span>
          </div>
        </div>

        <div className="model-spec-card">
          <div className="model-spec-top">
            <div className="model-title-group">
              <span className="model-name">Gemini 2.5 Flash</span>
              <span className="model-badge">Visual Verification</span>
            </div>
          </div>
          <p className="model-spec-desc">
            Google&apos;s native multimodal model that inspects UI screenshots taken by the headless
            Chromium sidecar. Detects layout regressions, alignment shifts, and missing styling.
          </p>
          <div className="model-spec-meta">
            <span className="meta-tag">1M+ Context</span>
            <span className="meta-tag">Native DOM &amp; Vision</span>
            <span className="meta-tag">High Concurrency</span>
          </div>
        </div>
      </div>

      <div className="models-byok-banner">
        <div className="byok-content">
          <Icon name="sparkles" size={16} />
          <span>
            <strong>Zero Vendor Lock-in:</strong> Connect your personal OpenRouter or Anthropic API key,
            or run on Aitar&apos;s managed cloud credits.
          </span>
        </div>
      </div>
    </section>
  );
}
