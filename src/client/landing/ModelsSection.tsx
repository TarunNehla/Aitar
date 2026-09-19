export function ModelsSection() {
  return (
    <section id="models" className="section-container">
      <div className="section-header">
        <span className="section-kicker">Multi-Model Intelligence</span>
        <h2 className="section-title">The world&apos;s best AI coding models</h2>
        <p className="section-sub">
          Aitar orchestrates top-tier frontier models through OpenRouter, giving you the flexibility
          to match reasoning power and speed to each individual task.
        </p>
      </div>

      <div className="models-grid">
        <div className="model-card">
          <div className="model-card-header">
            <span className="model-card-name">Claude 3.7 Sonnet</span>
            <span className="model-tag claude">Hybrid Reasoning</span>
          </div>
          <p className="model-card-desc">
            Anthropic&apos;s premier model featuring toggleable thinking levels (Off, Low, Medium, High).
            Unmatched precision across complex architecture design, tricky edge cases, and deep multi-file refactoring.
          </p>
          <div className="model-specs">
            <span>Context: 200k tokens</span>
            <span>Thinking: Dynamic</span>
          </div>
        </div>

        <div className="model-card">
          <div className="model-card-header">
            <span className="model-card-name">DeepSeek V4 Flash</span>
            <span className="model-tag deepseek">Speed &amp; Efficiency</span>
          </div>
          <p className="model-card-desc">
            Ultra-fast inference tailored for rapid code generation, unit test creation, and interactive
            debugging loops. Highly cost-effective for high-volume developer sessions.
          </p>
          <div className="model-specs">
            <span>Context: 128k tokens</span>
            <span>Latency: Sub-second</span>
          </div>
        </div>

        <div className="model-card">
          <div className="model-card-header">
            <span className="model-card-name">Gemini 3.7 Flash</span>
            <span className="model-tag gemini">Multimodal Vision</span>
          </div>
          <p className="model-card-desc">
            High-throughput vision model powering Aitar&apos;s automated visual inspection. Analyzes UI screenshots
            captured by the Chromium sidecar to verify layouts and color themes.
          </p>
          <div className="model-specs">
            <span>Context: 1M+ tokens</span>
            <span>Vision: Native</span>
          </div>
        </div>
      </div>
    </section>
  );
}
