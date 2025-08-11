// controllers/depositController.js
import db from '../config/db.js';
import QRCode from 'qrcode';
import { buildQrisPayload } from '../utils/qris.js';
import { randomInt, generateDepositId } from '../utils/random.js';
import { notifyAdmins } from '../bot/whatsapp.js';

export async function createDeposit(req, res) {
  const { amount } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const kodeUnik = randomInt(100, 999);
    const total = Number(amount) + kodeUnik;

    const [payloads] = await db.query('SELECT id,payload_text FROM payloads');
    if (!payloads || payloads.length === 0) return res.status(500).json({ error: 'No payloads configured' });

    const chosen = payloads[Math.floor(Math.random() * payloads.length)].payload_text;
    const finalPayload = buildQrisPayload(chosen, String(Math.round(total)));
    const qrImage = await QRCode.toDataURL(finalPayload);

    // generate short deposit id PN-XXXXX and ensure unique
    let depositId = generateDepositId();
    let tries = 0;
    while (tries < 10) {
      const [r] = await db.query('SELECT id FROM deposits WHERE deposit_id = ?', [depositId]);
      if (!r || r.length === 0) break;
      depositId = generateDepositId();
      tries++;
    }

    const expiredAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await db.query('INSERT INTO deposits (deposit_id,user_id,amount,kode_unik,status,created_at,expired_at,qr_image,payload) VALUES (?,?,?,?,NOW(),?,?,?,?)',
      [depositId, req.user.id, total, kodeUnik, 'pending', expiredAt, qrImage, finalPayload]);

    // notify admins
    await notifyAdmins({ depositId, amount: total, username: req.user.username, userId: req.user.id });

    res.json({ depositId, amount: total, qrImage, expiredAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create deposit' });
  }
}

export async function getDeposit(req, res) {
  const depositId = req.params.depositId;
  try {
    const [rows] = await db.query('SELECT * FROM deposits WHERE deposit_id = ? AND user_id = ?', [depositId, req.user.id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Deposit not found' });
    const d = rows[0];
    if (d.status === 'pending' && new Date(d.expired_at) < new Date()) {
      await db.query('UPDATE deposits SET status = ? WHERE id = ?', ['expired', d.id]);
      d.status = 'expired';
    }
    delete d.payload;
    res.json(d);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
}

export async function listDeposits(req, res) {
  try {
    const [rows] = await db.query('SELECT deposit_id,amount,kode_unik,status,created_at,expired_at FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
}

export async function mutations(req, res) {
  try {
    const [rows] = await db.query('SELECT * FROM mutations WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
}
