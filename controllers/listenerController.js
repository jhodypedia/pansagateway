// controllers/listenerController.js
import db from '../config/db.js';
import { notifyAdmins } from '../bot/whatsapp.js';

export async function qrisListener(req, res) {
  try {
    // Validasi API key
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.LISTENER_API_KEY || "4rc0d3" ) {
      return res.status(403).json({ error: 'Invalid API key' });
    }

    const { title, message, amount } = req.body;
    if (!amount) {
      return res.status(400).json({ error: 'Amount is required' });
    }

    const nominal = parseFloat(amount);
    if (isNaN(nominal)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Cari deposit pending yang cocok
    const [depositRows] = await db.query(
      `SELECT * FROM deposits 
       WHERE status='pending' AND amount=? 
       ORDER BY created_at ASC 
       LIMIT 1`,
      [nominal]
    );

    if (!depositRows.length) {
      return res.status(404).json({ error: 'No matching deposit found' });
    }

    const deposit = depositRows[0];

    // Update status deposit menjadi success
    await db.query(`UPDATE deposits SET status='success' WHERE id=?`, [deposit.id]);

    // Update saldo user
    await db.query(`UPDATE users SET saldo = saldo + ? WHERE id=?`, [deposit.amount, deposit.user_id]);

    // Ambil saldo terbaru user
    const [[user]] = await db.query(`SELECT username, saldo FROM users WHERE id=?`, [deposit.user_id]);

    // Catat ke mutations
    await db.query(
      `INSERT INTO mutations (user_id, type, amount, balance_after, description) 
       VALUES (?, 'credit', ?, ?, ?)`,
      [deposit.user_id, deposit.amount, user.saldo, `Deposit QRIS ${deposit.deposit_id} sukses`]
    );

    // Kirim notifikasi ke admin via WhatsApp
    await notifyAdmins({
      depositId: deposit.deposit_id,
      username: user.username,
      amount: deposit.amount
    });

    console.log(`✅ Deposit ${deposit.deposit_id} sukses (QRIS)`);

    res.json({
      success: true,
      message: `Deposit ${deposit.deposit_id} sukses`,
      user: user.username,
      saldo: user.saldo
    });

  } catch (err) {
    console.error('Listener error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
