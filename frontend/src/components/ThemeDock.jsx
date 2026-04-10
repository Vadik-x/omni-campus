export default function ThemeDock({ theme = "relaxed", onToggle }) {
  const relaxed = theme !== "war-room";

  return (
    <button
      type="button"
      className={`theme-dock-btn ${relaxed ? "relaxed" : "war-room"}`}
      onClick={onToggle}
      aria-label="Toggle app theme"
      title="Toggle app theme"
    >
      <span className="theme-dock-dot" aria-hidden="true" />
      <span className="theme-dock-copy">
        <strong>{relaxed ? "Relaxed" : "War Room"} Theme</strong>
        <small>{relaxed ? "Switch to dark" : "Switch to calm"}</small>
      </span>
    </button>
  );
}
