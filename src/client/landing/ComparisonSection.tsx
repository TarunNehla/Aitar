export function ComparisonSection() {
  return (
    <section className="section-container">
      <div className="section-header">
        <span className="section-kicker">Architectural Comparison</span>
        <h2 className="section-title">Why developers choose Aitar</h2>
        <p className="section-sub">
          Stop copying and pasting code blocks or risking arbitrary shell execution on your personal laptop.
        </p>
      </div>

      <div className="comparison-table-wrap">
        <table className="comparison-table">
          <thead>
            <tr>
              <th>Capability</th>
              <th>Chat AI (Web LLMs)</th>
              <th>Local CLI Agents</th>
              <th className="highlight">Aitar Cloud</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Execution Environment</strong></td>
              <td>None (manual copy-paste)</td>
              <td>Your personal laptop (risky)</td>
              <td className="highlight"><strong>Isolated Docker Container</strong></td>
            </tr>
            <tr>
              <td><strong>Live Web UI Testing</strong></td>
              <td>❌ Blind to UI &amp; DOM</td>
              <td>❌ Blind to UI &amp; DOM</td>
              <td className="highlight"><strong>✅ Real Chromium Sidecar</strong></td>
            </tr>
            <tr>
              <td><strong>Hardware &amp; Battery Impact</strong></td>
              <td>Minimal</td>
              <td>Heavy (spins up local fans)</td>
              <td className="highlight"><strong>Zero (100% Cloud VPS)</strong></td>
            </tr>
            <tr>
              <td><strong>Git Checkpoint Safety</strong></td>
              <td>Manual</td>
              <td>Can overwrite working trees</td>
              <td className="highlight"><strong>Automated turn checkpoints</strong></td>
            </tr>
            <tr>
              <td><strong>Direct GitHub PR Creation</strong></td>
              <td>Manual git commands</td>
              <td>Local git push permissions</td>
              <td className="highlight"><strong>1-Click App PR Generation</strong></td>
            </tr>
            <tr>
              <td><strong>Hybrid Reasoning Control</strong></td>
              <td>Fixed</td>
              <td>CLI flags</td>
              <td className="highlight"><strong>Real-time thinking sliders</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
