export function MetricsStrip() {
  return (
    <div className="landing-metrics-strip">
      <div className="metrics-container">
        <div className="metric-item">
          <span className="metric-value">100%</span>
          <span className="metric-label">Isolated Docker Sandboxes</span>
        </div>
        <div className="metric-item">
          <span className="metric-value">Chromium</span>
          <span className="metric-label">Headless UI Testing Sidecar</span>
        </div>
        <div className="metric-item">
          <span className="metric-value">30+ Turns</span>
          <span className="metric-label">Autonomous Context Budget</span>
        </div>
        <div className="metric-item">
          <span className="metric-value">0 sec</span>
          <span className="metric-label">Local Machine Setup Time</span>
        </div>
      </div>
    </div>
  );
}
