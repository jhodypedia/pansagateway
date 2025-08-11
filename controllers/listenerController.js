// controllers/listenerController.js
import db from '../config/db.js';
import { notifyAdmins } from '../bot/whatsapp.js';
import dotenv from 'dotenv';
dotenv.config();

const LISTENER_API_KEY = process.env.LISTENER_API_KEY || '4rc0d3';
const MATCH_WINDOW_MIN = Number(process.env.LISTENER_MATCH_WINDOW_MIN || 30);

/** Normalisasi angka dari string: '50.330' or '50330' -> 50330 */
function parseAmount(val) {
  if (val == null) return 0;
  const s = String(val).replace(/\s/g, '').replace(/\./g, '').replace(/,/g, '.');
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

export async function listenerEndpoint(req, res) {
  try {
    const key = (req.header('x-api-key') || '').trim();
    if (!key || key !== LISTENER_API_KEY) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const body = req.body || {};
    const title = body.title || null;
    const message = body.message || null;
    const timestamp = body.timestamp || null;
    const amountRaw = body.amount ?? body.nominal ?? null;
    const amount = parseAmount(amountRaw);

    // Save incoming notification
    const raw = JSON.stringify(body);
    const [ins] = await db.query(
      'INSERT INTO incoming_notifications (title, message, amount, raw_json) VALUES (?,?,?,?)',
      [title, message, amount, raw]
    );
    const incomingId = ins.insertId;

    // Try match auto-confirm if amount > 0
    let matched = null;
    if (amount > 0) {
      // find pending deposits with exact amount within time window
      const q = `
        SELECT d.* , u.username
        FROM deposits d
        LEFT JOIN users u ON u.id = d.user_id
        WHERE d.status = 'pending'
          AND d.amount = ?
          AND d.created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
        ORDER BY d.created_at ASC
        LIMIT 1
      `;
      const [candidates] = await db.query(q, [amount, MATCH_WINDOW_MIN]);

      if (candidates && candidates.length > 0) {
        matched = candidates[0];

        // 1) update deposit status -> success
        await db.query('UPDATE deposits SET status = ?, updated_at = NOW() WHERE deposit_id = ?', ['success', matched.deposit_id]);

        // 2) credit user saldo & insert mutation
        if (matched.user_id) {
          const [urows] = await db.query('SELECT saldo FROM users WHERE id = ?', [matched.user_id]);
          const oldSaldo = (urows && urows[0]) ? Number(urows[0].saldo || 0) : 0;
          const newSaldo = oldSaldo + Number(matched.amount || 0);

          await db.query('UPDATE users SET saldo = ?, updated = NOW() WHERE id = ?', [newSaldo, matched.user_id]);

          await db.query(
            'INSERT INTO mutations (user_id,type,amount,balance_after,description,created_at) VALUES (?,?,?,?,?,NOW())',
            [matched.user_id, 'credit', matched.amount, newSaldo, `Auto-confirm by listener (incomingId:${incomingId})`]
          );
        }

        // 3) update incoming_notifications matched fields
        await db.query('UPDATE incoming_notifications SET matched_deposit_id = ?, matched_at = NOW() WHERE id = ?',
          [matched.deposit_id, incomingId]);

        // 4) notify admins (user only receives notification)
        try {
          await notifyAdmins({
            depositId: matched.deposit_id,
            userId: matched.user_id,
            username: matched.username || null,
            amount: matched.amount
          });
        } catch (err) {
          console.error('notifyAdmins failed', err);
        }
      }
    }

    return res.json({
      ok: true,
      incomingId,
      matched: matched ? { deposit_id: matched.deposit_id, user_id: matched.user_id, amount: matched.amount } : null
    });

  } catch (err) {
    console.error('listenerEndpoint error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}
