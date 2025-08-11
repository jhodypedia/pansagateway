// controllers/authController.js
import db from '../config/db.js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

export async function register(req, res) {
  const { username, email, password, activation_code } = req.body;
  if (!username || !email || !password || !activation_code) return res.status(400).json({ error: 'username,email,password,activation_code required' });

  try {
    const [codes] = await db.query('SELECT * FROM activation_codes WHERE code = ? AND used_by IS NULL', [activation_code]);
    if (!codes || codes.length === 0) return res.status(400).json({ error: 'Invalid or used activation code' });

    const hash = await bcrypt.hash(password, 10);
    const apikey = crypto.randomBytes(24).toString('hex');
    const [ins] = await db.query('INSERT INTO users (username,email,password,apikey) VALUES (?,?,?,?)', [username, email, hash, apikey]);
    const userId = ins.insertId;

    await db.query('UPDATE activation_codes SET used_by = ?, used_at = NOW() WHERE id = ?', [userId, codes[0].id]);
    return res.json({ message: 'Registered', apikey });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Registration failed' });
  }
}

export async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email & password required' });
  try {
    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];
    const ok = await bcrypt.compare(password, u.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    return res.json({ apikey: u.apikey, username: u.username, saldo: u.saldo });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'DB error' });
  }
}

export async function profile(req, res) {
  try {
    const [rows] = await db.query('SELECT id,username,email,saldo,apikey,datetime,updated FROM users WHERE id = ?', [req.user.id]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
}
