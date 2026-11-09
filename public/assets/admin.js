const statusEl = document.getElementById('status');
  const dashboard = document.getElementById('dashboard');

  async function loadStats() {
    const key = document.getElementById('admin-key').value.trim();
    if (!key) { statusEl.textContent = 'Enter the admin key from your .env file.'; return; }

    statusEl.textContent = 'Loading…';
    try {
      const res = await fetch(`/api/admin/stats?key=${encodeURIComponent(key)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');

      document.getElementById('kpi-views').textContent = data.totals.page_views;
      document.getElementById('kpi-users').textContent = data.totals.users;

      const maxViews = Math.max(1, ...data.views_by_day.map(d => d.views));
      document.getElementById('views-by-day').innerHTML = data.views_by_day.length
        ? data.views_by_day.map(d => `
            <div class="mini-bar" style="height:${Math.max(4, (d.views / maxViews) * 100)}%;">
              <em>${new Date(d.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</em>
            </div>`).join('')
        : '<div class="empty">No page views logged yet.</div>';

      const fillTable = (id, rows, renderRow) => {
        const el = document.getElementById(id);
        el.innerHTML = rows.length ? rows.map(renderRow).join('') : '<tr><td colspan="3" class="empty">Nothing yet.</td></tr>';
      };

      fillTable('top-pages', data.top_pages, r => `<tr><td>${r.path}</td><td>${r.views}</td></tr>`);
      fillTable('top-events', data.top_events, r => `<tr><td>${r.event_name}</td><td>${r.count}</td></tr>`);
      fillTable('recent-signups', data.recent_signups, r =>
        `<tr><td>${r.name}</td><td>${r.goal || '—'}</td><td>${new Date(r.created_at).toLocaleString()}</td></tr>`);
      dashboard.style.display = 'block';
      statusEl.textContent = '';
    } catch (err) {
      statusEl.textContent = err.message;
      dashboard.style.display = 'none';
    }
  }

  document.getElementById('load-btn').addEventListener('click', loadStats);
  document.getElementById('admin-key').addEventListener('keydown', e => { if (e.key === 'Enter') loadStats(); });
