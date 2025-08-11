// middlewares/authMiddleware.js
import db from '../config/db.js';

export async function authMiddleware(req, res, next) {
  const apikey = req.headers['x-api-key'];
  if (!apikey) return res.status(401).json({ error: 'x-api-key header required' });
  try {
    const [rows] = await db.query('SELECT id,username,email,saldo,apikey FROM users WHERE apikey = ?', [apikey]);
    if (!rows || rows.length === 0) return res.status(403).json({ error: 'Invalid API key' });
    req.user = rows[0];
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
}
