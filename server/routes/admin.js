const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key-change-me';

// Deliberately simple: a shared-secret header/query param, not a real admin login.
// Fine for local monitoring while you build; swap for a proper authenticated
// admin role (or an internal-only route, per Fundrise's own "app security is a
// constant priority" stance) before this is ever exposed publicly.
function requireAdminKey(req, res, next) {
  const key = req.get('x-admin-key') || req.query.key;
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Missing or invalid admin key.' });
  }
  next();
}

router.get('/stats', requireAdminKey, async (req, res) => {
  try {
    const [[{ total_page_views }]] = await pool.query(
      'SELECT COUNT(*) AS total_page_views FROM page_views'
    );
    const [[{ total_users }]] = await pool.query('SELECT COUNT(*) AS total_users FROM users');

    const [topPages] = await pool.query(
      `SELECT path, COUNT(*) AS views
       FROM page_views
       GROUP BY path
       ORDER BY views DESC
       LIMIT 10`
    );

    const [viewsByDay] = await pool.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS views
       FROM page_views
       WHERE created_at >= NOW() - INTERVAL 14 DAY
       GROUP BY DATE(created_at)
       ORDER BY day ASC`
    );

    const [recentSignups] = await pool.query(
      `SELECT name, email, goal, horizon, created_at
       FROM users
       ORDER BY created_at DESC
       LIMIT 10`
    );

    const [topEvents] = await pool.query(
      `SELECT event_name, COUNT(*) AS count
       FROM events
       GROUP BY event_name
       ORDER BY count DESC
       LIMIT 10`
    );

    res.json({
      totals: {
        page_views: total_page_views,
        users: total_users,
      },
      top_pages: topPages,
      views_by_day: viewsByDay.map(r => ({ day: r.day, views: r.views })),
      recent_signups: recentSignups,
      top_events: topEvents,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong loading site stats.' });
  }
});

module.exports = router;
