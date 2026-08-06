export function Spinner({ size = 16, label }: { size?: 14 | 16 | 20; label?: string }) {
  return (
    <span className="spinner-row" role="status">
      <span className={`spinner spinner-${size}`} />
      {label && <span className="spinner-label">{label}</span>}
    </span>
  );
}
