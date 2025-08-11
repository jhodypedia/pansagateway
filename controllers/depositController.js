// controllers/depositController.js
import db from '../config/db.js';
import QRCode from 'qrcode';
import { buildQrisPayload } from '../utils/qris.js';
import { randomInt, generateDepositId } from '../utils/random.js';
import { notifyAdmins } from '../bot/whatsapp.js';

export async function createDeposit(req, res) {
  const { amount } = req.body;
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  try {
    const kodeUnik = randomInt(100, 999);
    const total = Number(amount) + kodeUnik;

    // Payload QRIS statis yang kamu berikan
    const basePayload =
      "00020101021226610014COM.GO-JEK.WWW01189360091438098430560210G8098430560303UMI51440014ID.CO.QRIS.WWW0215ID10254038798730303UMI5204549953033605405100005802ID5911Pansa Store6010BOJONEGORO61056211162395028A120250811073942Vg1nhqT6lJID0703A016304F805";

    // Bangun payload final sesuai total deposit
    const finalPayload = buildQrisPayload(basePayload, String(Math.round(total)));

    // Buat QR image
    const qrImage = await QRCode.toDataURL(finalPayload);

    // Generate deposit_id unik
    let depositId = generateDepositId();
    let tries = 0;
    while (tries < 10) {
      const [r] = await db.query('SELECT id FROM deposits WHERE deposit_id = ?', [depositId]);
      if (!r || r.length === 0) break;
      depositId = generateDepositId();
      tries++;
    }

    const expiredAt = new Date(Date.now() + 15 * 60 * 1000); // 15 menit

    // Simpan ke DB
    await db.query(
      'INSERT INTO deposits (deposit_id,user_id,amount,kode_unik,status,created_at,expired_at,qr_image,payload) VALUES (?,?,?,?,NOW(),?,?,?,?)',
      [depositId, req.user.id, total, kodeUnik, 'pending', expiredAt, qrImage, finalPayload]
    );

    // Kirim notifikasi admin
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
    const [rows] = await db.query(
      'SELECT deposit_id,amount,kode_unik,status,created_at,expired_at FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
}

export async function mutations(req, res) {
  try {
    const [rows] = await db.query(
      'SELECT * FROM mutations WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
}
