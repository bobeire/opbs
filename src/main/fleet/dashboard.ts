/**
 * Fleet dashboard: a single self-contained HTML page served by the fleet
 * server at /. Vanilla JS, no build step, no external assets — it fetches
 * /api/fleet and renders one row per machine. Written without template
 * literals inside so the page stays a plain string constant.
 */
export const FLEET_DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OPBS Fleet</title>
<style>
  :root {
    --bg: #10141a; --panel: #171d26; --border: #273040; --text: #dbe2ee;
    --muted: #8593a8; --ok: #3fb950; --warning: #d29922; --critical: #f85149;
    --stale: #8b949e; --accent: #58a6ff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 14px/1.45 "Segoe UI", system-ui, sans-serif; }
  header { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
           padding: 18px 24px 10px; }
  h1 { font-size: 18px; margin: 0; font-weight: 600; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip { padding: 2px 10px; border-radius: 999px; font-size: 12px;
          background: var(--panel); border: 1px solid var(--border); }
  .chip b { font-weight: 600; }
  .chip.ok b { color: var(--ok); } .chip.warning b { color: var(--warning); }
  .chip.critical b { color: var(--critical); } .chip.stale b { color: var(--stale); }
  #meta { margin-left: auto; color: var(--muted); font-size: 12px; }
  main { padding: 8px 24px 32px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel);
          border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border);
           vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
       color: var(--muted); font-weight: 600; background: #1b2330; }
  tr:last-child td { border-bottom: none; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%;
         margin-right: 8px; vertical-align: baseline; }
  .dot.ok { background: var(--ok); } .dot.warning { background: var(--warning); }
  .dot.critical { background: var(--critical); }
  .dot.stale { background: var(--stale); }
  .host { font-weight: 600; }
  .sub { color: var(--muted); font-size: 12px; }
  .reasons { color: var(--warning); font-size: 12px; margin-top: 3px; }
  .reasons.critical { color: var(--critical); }
  .bad { color: var(--critical); font-weight: 600; }
  .warn { color: var(--warning); }
  .good { color: var(--ok); }
  .empty { padding: 28px; text-align: center; color: var(--muted);
           background: var(--panel); border: 1px solid var(--border);
           border-radius: 8px; }
  footer { padding: 0 24px 24px; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>OPBS Fleet</h1>
  <div class="chips" id="chips"></div>
  <div id="meta"></div>
</header>
<main id="main"><div class="empty">Loading&hellip;</div></main>
<footer id="foot"></footer>
<script>
(function () {
  var ORDER = { critical: 0, stale: 1, warning: 2, ok: 3 };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function age(ms) {
    if (ms == null) return '<span class="sub">never</span>';
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) return s + 's ago';
    var m = Math.round(s / 60);
    if (m < 90) return m + 'm ago';
    var h = Math.round(m / 60);
    if (h < 48) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }
  function backupAge(checkin) {
    var newest = null;
    checkin.destinations.forEach(function (d) {
      if (d.lastBackupAt != null && (newest === null || d.lastBackupAt > newest)) {
        newest = d.lastBackupAt;
      }
    });
    return age(newest);
  }
  function chains(checkin) {
    var total = 0, broken = 0;
    checkin.destinations.forEach(function (d) { total += d.chainCount; broken += d.brokenChains; });
    if (total === 0) return '<span class="sub">no chains</span>';
    return broken > 0
      ? '<span class="bad">' + (total - broken) + '/' + total + '</span>'
      : (total - broken) + '/' + total;
  }
  function anomalies(checkin) {
    var crit = 0, warn = 0;
    checkin.destinations.forEach(function (d) { crit += d.criticalAnomalies; warn += d.warningAnomalies; });
    if (crit + warn === 0) return '<span class="good">none</span>';
    var out = [];
    if (crit > 0) out.push('<span class="bad">' + crit + ' critical</span>');
    if (warn > 0) out.push('<span class="warn">' + warn + ' warning</span>');
    return out.join(', ');
  }
  function drills(checkin) {
    var total = 0, failed = 0, lastOk = null, lastAt = null;
    checkin.destinations.forEach(function (d) {
      total += d.drillTotal; failed += d.drillFailed;
      if (d.drillLastAt != null && (lastAt === null || d.drillLastAt > lastAt)) {
        lastAt = d.drillLastAt; lastOk = d.drillLastOk;
      }
    });
    if (total === 0) return '<span class="sub">never drilled</span>';
    if (lastOk === false) return '<span class="bad">last drill failed</span>';
    return '<span class="good">' + (total - failed) + '/' + total + ' passed</span>';
  }
  function media(checkin) {
    if (!checkin.media || checkin.media.length === 0) return '<span class="sub">n/a</span>';
    var bad = 0;
    checkin.media.forEach(function (m) { if (m.healthy === false && m.measured) bad++; });
    if (bad > 0) return '<span class="bad">' + bad + ' of ' + checkin.media.length + ' disks</span>';
    return checkin.media.length + ' disk(s) ok';
  }
  function render(data) {
    var chips = { ok: 0, warning: 0, critical: 0, stale: 0 };
    data.machines.forEach(function (m) { chips[m.status]++; });
    document.getElementById('chips').innerHTML =
      '<span class="chip ok"><b>' + chips.ok + '</b> ok</span>' +
      '<span class="chip warning"><b>' + chips.warning + '</b> warning</span>' +
      '<span class="chip critical"><b>' + chips.critical + '</b> critical</span>' +
      '<span class="chip stale"><b>' + chips.stale + '</b> stale</span>';
    document.getElementById('meta').textContent =
      data.machineCount + ' machine(s), refreshed ' + new Date(data.generatedAt).toLocaleTimeString();

    var main = document.getElementById('main');
    if (data.machines.length === 0) {
      main.innerHTML = '<div class="empty">No check-ins yet. Run <code>fleet checkin</code> on a ' +
        'machine and point it at this server.</div>';
      document.getElementById('foot').textContent = '';
      return;
    }
    var sorted = data.machines.slice().sort(function (a, b) {
      var d = ORDER[a.status] - ORDER[b.status];
      return d !== 0 ? d : a.hostname.localeCompare(b.hostname);
    });
    var rows = sorted.map(function (m) {
      var c = m.checkin;
      var reasons = m.reasons.length
        ? '<div class="reasons' + (m.status === 'critical' ? ' critical' : '') + '">' +
          m.reasons.map(esc).join('<br>') + '</div>'
        : '';
      return '<tr>' +
        '<td><span class="dot ' + m.status + '"></span>' + esc(m.status) + '</td>' +
        '<td><div class="host">' + esc(m.hostname) + '</div>' +
        '<div class="sub">' + esc(m.machineId) + ' &middot; v' + esc(c.appVersion) + '</div>' + reasons + '</td>' +
        '<td>' + age(m.receivedAt) + '</td>' +
        '<td>' + backupAge(c) + '</td>' +
        '<td>' + chains(c) + '</td>' +
        '<td>' + anomalies(c) + '</td>' +
        '<td>' + drills(c) + '</td>' +
        '<td>' + media(c) + '</td>' +
        '</tr>';
    }).join('');
    main.innerHTML = '<table><thead><tr>' +
      '<th>Status</th><th>Machine</th><th>Last check-in</th><th>Last backup</th>' +
      '<th>Chains</th><th>Anomalies</th><th>Drills</th><th>Media</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
    document.getElementById('foot').textContent =
      'Stale threshold: ' + data.staleDays + ' day(s) without a check-in. Auto-refreshes every 60 s.';
  }
  function load() {
    fetch('/api/fleet')
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {
        document.getElementById('main').innerHTML =
          '<div class="empty">Cannot reach /api/fleet &mdash; the server may be restarting.</div>';
      });
  }
  load();
  setInterval(load, 60000);
})();
</script>
</body>
</html>
`;
