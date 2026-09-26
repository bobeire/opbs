function SplashScreen() {
  return (
    <div className="splash-screen">
      <div className="splash-card">
        <div className="splash-logo">OPBS</div>
        <p className="splash-subtitle">Open Pickle Backup System</p>
        <div className="splash-spinner" />
        <p className="splash-status">Loading drives and backup data…</p>
      </div>
    </div>
  );
}

export default SplashScreen;
