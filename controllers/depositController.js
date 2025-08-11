// controllers/depositController.js
import db from '../config/db.js';
import QRCode from 'qrcode';
import { buildQrisPayload } from '../utils/qris.js';
import { randomInt, generateDepositId } from '../utils/random.js';
import { notifyAdmins } from '../bot/whatsapp.js';

// Payload QRIS statis (dari gambar kamu) dengan placeholder nominal
const STATIC_QRIS_PAYLOAD =
  "00020101021126610014COM.GO-JEK.WWW01189360091438098430560210G8098430560303UMI51440014ID.CO.QRIS.WWW0215ID10254038798730303UMI5204549953033605802ID5911Pansa Store6010BOJONEGORO61056211162070703A01{AMOUNT_FIELD}6304";

export async function createDeposit(req, res) {
  const { amount } = req.body;
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  try {
    // Buat kode unik (3 digit)
    const kodeUnik = randomInt(100, 999);
    const total = Number(amount) + kodeUnik;

    // Bangun payload QRIS dengan nominal
    const finalPayload = buildQrisPayload(STATIC_QRIS_PAYLOAD, total);

    // Generate QR code image (base64)
    const qrImage = await QRCode.toDataURL(finalPayload);

    // Buat deposit ID unik
    let depositId = generateDepositId();
    let tries = 0;
    while (tries < 10) {
      const [r] = await db.query('SELECT id FROM deposits WHERE deposit_id = ?', [depositId]);
      if (!r || r.length === 0) break;
      depositId = generateDepositId();
      tries++;
    }

    const expiredAt = new Date(Date.now() + 15 * 60 * 1000); // Expired 15 menit

    // Simpan ke database
    await db.query(
      `INSERT INTO deposits 
       (deposit_id, user_id, amount, kode_unik, status, created_at, expired_at, qr_image, payload) 
       VALUES (?, ?, ?, ?, 'pending', NOW(), ?, ?, ?)`,
      [depositId, req.user.id, total, kodeUnik, expiredAt, qrImage, finalPayload]
    );

    // Notifikasi ke admin via WhatsApp
    await notifyAdmins({
      depositId,
      amount: total,
      username: req.user.username,
      userId: req.user.id
    });

    res.json({ depositId, amount: total, qrImage, expiredAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create deposit' });
  }
}

export async function getDeposit(req, res) {
  const depositId = req.params.depositId;
  try {
    const [rows] = await db.query(
      'SELECT * FROM deposits WHERE deposit_id = ? AND user_id = ?',
      [depositId, req.user.id]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'Deposit not found' });
    }

    const d = rows[0];
    if (d.status === 'pending' && new Date(d.expired_at) < new Date()) {
      await db.query('UPDATE deposits SET status = ? WHERE id = ?', ['expired', d.id]);
      d.status = 'expired';
    }

    delete d.payload; // jangan kirim payload QRIS mentah ke user
    res.json(d);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
}

export async function listDeposits(req, res) {
  try {
    const [rows] = await db.query(
      `SELECT deposit_id, amount, kode_unik, status, created_at, expired_at 
       FROM deposits 
       WHERE user_id = ? 
       ORDER BY created_at DESC LIMIT 200`,
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
