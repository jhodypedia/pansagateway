// bot/whatsapp.js
import baileys, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
const { makeWASocket } = baileys;
import P from 'pino';
import qrcode from 'qrcode-terminal';
import db from '../config/db.js';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
dotenv.config();

const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || '6283129635860').split(',').map(s => s.trim());
const AUTH_PATH = process.env.WA_AUTH_PATH || './auth_info';
const PRINT_QR = (process.env.SESSION_PRINT_QR || 'true') === 'true';

let sock = null;

function isAdminNumber(number) {
  return ADMIN_NUMBERS.includes(number);
}

function extractTextFromMessage(msg) {
  // try various places where text may be found (conversation, extendedTextMessage, buttons, list)
  try {
    if (!msg || !msg.message) return '';
    const m = msg.message;
    if (m.conversation) return m.conversation.trim();
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text.trim();
    // buttonsResponseMessage (when user taps a button)
    if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId.trim();
    if (m.buttonsResponseMessage?.selectedDisplayText) return m.buttonsResponseMessage.selectedDisplayText.trim();
    // listResponseMessage (when user selects from list)
    if (m.listResponseMessage?.singleSelectReply?.selectedRowId) return m.listResponseMessage.singleSelectReply.selectedRowId.trim();
    if (m.listResponseMessage?.singleSelectReply?.selectedDisplayText) return m.listResponseMessage.singleSelectReply.selectedDisplayText.trim();
    return '';
  } catch (e) {
    return '';
  }
}

export async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    logger: P({ level: 'warn' }),
    printQRInTerminal: false,
    auth: state,
    version,
    browser: ['Pansa Gateway Bot', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    try {
      const { connection, qr, lastDisconnect } = update;
      if (qr && PRINT_QR) {
        qrcode.generate(qr, { small: true });
        console.log('QR code printed to terminal (scan with admin WA).');
      }
      if (connection === 'open') {
        console.log('✅ WhatsApp connected');
      }
      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        console.log('❌ WhatsApp disconnected', reason || lastDisconnect?.error);
        if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
          console.log('🔄 Reconnect attempt...');
          setTimeout(() => initWhatsApp().catch(e => console.error('Reconnect failed', e)), 2000);
        } else {
          console.log('❗ Session logged out. Delete auth files and re-scan QR.');
        }
      }
    } catch (err) {
      console.error('connection.update handler error', err);
    }
  });

  sock.ev.on('messages.upsert', async (mUpsert) => {
    try {
      const messages = mUpsert.messages;
      if (!messages?.length) return;
      const msg = messages[0];

      if (!msg || !msg.message) return;
      if (msg.key?.fromMe) return; // skip messages sent by the bot itself

      const jid = msg.key.remoteJid; // e.g. 6283....@s.whatsapp.net or group@g.us
      const sender = jid.split('@')[0];
      const isGroup = jid.endsWith('@g.us');

      // ignore groups entirely
      if (isGroup) {
        // optionally log
        // console.log('Ignored group message from', jid);
        return;
      }

      // only respond to admin numbers
      if (!isAdminNumber(sender)) {
        // ignore non-admin chats entirely
        return;
      }

      // extract text (handles normal text, extendedText, buttons, list selections)
      let text = extractTextFromMessage(msg);
      if (!text) return;

      // If buttons/list return something like ".sukses PN-xxx" (we accept it), but some button payloads may be the display text instead:
      // Normalize: if text starts with the display text e.g. "✅ Konfirmasi" we don't have id; but we design our buttons to have buttonId equal to full command (e.g. ".sukses PN-xxx")
      // So proceed to parse command:
      const parts = text.split(/\s+/).filter(Boolean);
      const cmd = parts[0].toLowerCase();

      // ---------- HELP & MENU ----------
      if (cmd === '.help' || cmd === '.menu') {
        // show both buttons and list for convenience
        await sock.sendMessage(jid, {
          text: `🛠 *Pansa Gateway Admin Panel*\nPilih opsi atau ketik perintah.\nKetik .help untuk daftar perintah.`,
          footer: "© Pansa Gateway",
          title: "📌 Menu Admin",
          buttonText: "Quick Actions",
          sections: [
            {
              title: "👤 Kelola User",
              rows: [
                { title: "➕ Tambah User", rowId: ".adduser" },
                { title: "❌ Hapus User", rowId: ".deleteuser" },
                { title: "📜 List User", rowId: ".listuser" }
              ]
            },
            {
              title: "💰 Deposit",
              rows: [
                { title: "📜 List Deposit", rowId: ".listdeposit" },
                { title: "✅ Konfirmasi Sukses", rowId: ".sukses" },
                { title: "🚫 Reject Deposit", rowId: ".reject" }
              ]
            },
            {
              title: "🧩 Payload QRIS",
              rows: [
                { title: "➕ Tambah Payload", rowId: ".addpayload" },
                { title: "📜 List Payload", rowId: ".listpayload" },
                { title: "❌ Hapus Payload", rowId: ".deletepayload" }
              ]
            },
            {
              title: "🔑 Activation Code",
              rows: [
                { title: "➕ Buat Code", rowId: ".createcode" },
                { title: "📜 List Code", rowId: ".listcode" },
                { title: "❌ Hapus Code", rowId: ".deletecode" }
              ]
            }
          ]
        });
        return;
      }

      // ---------- USER ----------
      if (cmd === '.adduser') {
        // format: .adduser username email password [saldo]
        const username = parts[1];
        const email = parts[2];
        const password = parts[3];
        const saldoRaw = parts[4] || '0';
        if (!username || !email || !password) {
          return sock.sendMessage(jid, { text: 'Format: `.adduser <username> <email> <password> [saldo]`' });
        }
        const hashed = await bcrypt.hash(password, 10);
        const saldo = parseInt(saldoRaw) || 0;
        await db.query('INSERT INTO users (username,email,password,saldo,created_at) VALUES (?,?,?,?,NOW())', [username, email, hashed, saldo]);
        return sock.sendMessage(jid, { text: `✅ User *${username}* dibuat. Saldo awal: Rp${saldo}` });
      }

      if (cmd === '.deleteuser') {
        // format: .deleteuser username
        const username = parts[1];
        if (!username) return sock.sendMessage(jid, { text: 'Format: `.deleteuser <username>`' });
        const [rows] = await db.query('SELECT id FROM users WHERE username=?', [username]);
        if (!rows.length) return sock.sendMessage(jid, { text: `📭 User *${username}* tidak ditemukan.` });
        await db.query('DELETE FROM users WHERE username=?', [username]);
        return sock.sendMessage(jid, { text: `🗑 User *${username}* dihapus.` });
      }

      if (cmd === '.listuser') {
        const [rows] = await db.query('SELECT username,email,saldo,created_at FROM users ORDER BY id DESC LIMIT 100');
        if (!rows.length) return sock.sendMessage(jid, { text: '📭 Tidak ada user.' });
        // send as few messages (each message limited); include button to delete per user
        let chunk = [];
        for (const u of rows) {
          const line = `👤 ${u.username} | ✉ ${u.email} | 💰 Rp${u.saldo}`;
          // send each user with action buttons (delete)
          await sock.sendMessage(jid, {
            text: line,
            footer: "User actions",
            buttons: [
              { buttonId: `.deleteuser ${u.username}`, buttonText: { displayText: '❌ Hapus' }, type: 1 }
            ],
            headerType: 1
          });
        }
        return;
      }

      // ---------- ACTIVATION CODES ----------
      if (cmd === '.createcode') {
        const code = parts[1];
        if (!code) return sock.sendMessage(jid, { text: 'Format: `.createcode <CODE>`' });
        await db.query('INSERT INTO activation_codes (code, created_at) VALUES (?,NOW())', [code]);
        return sock.sendMessage(jid, { text: `🔑 Activation code *${code}* dibuat.` });
      }

      if (cmd === '.listcode') {
        const [rows] = await db.query('SELECT code,created_at,used_by,used_at FROM activation_codes ORDER BY id DESC LIMIT 200');
        if (!rows.length) return sock.sendMessage(jid, { text: '📭 Tidak ada kode.' });
        const textOut = rows.map(r => `${r.code} | used_by:${r.used_by || '-'} | used_at:${r.used_at || '-'} | created:${r.created_at}`).join('\n');
        return sock.sendMessage(jid, { text: `📜 Activation Codes\n\n${textOut}` });
      }

      if (cmd === '.deletecode') {
        const code = parts[1];
        if (!code) return sock.sendMessage(jid, { text: 'Format: `.deletecode <CODE>`' });
        await db.query('DELETE FROM activation_codes WHERE code=?', [code]);
        return sock.sendMessage(jid, { text: `🗑 Code *${code}* dihapus.` });
      }

      // ---------- QRIS PAYLOAD ----------
      if (cmd === '.addpayload') {
        // format: .addpayload NAME|PAYLOAD_TEXT
        const raw = text.substring('.addpayload'.length).trim();
        const sep = raw.indexOf('|');
        if (sep === -1) return sock.sendMessage(jid, { text: 'Format: `.addpayload <NAME>|<PAYLOAD_TEXT>`' });
        const name = raw.slice(0, sep).trim();
        const payload = raw.slice(sep + 1).trim();
        if (!name || !payload) return sock.sendMessage(jid, { text: 'Nama atau payload kosong.' });
        await db.query('INSERT INTO qris_payloads (name,payload_text,created_at) VALUES (?,?,NOW())', [name, payload]);
        return sock.sendMessage(jid, { text: `🧩 Payload *${name}* ditambahkan.` });
      }

      if (cmd === '.listpayload') {
        const [rows] = await db.query('SELECT id,name,LEFT(payload_text,120) as preview,created_at FROM qris_payloads ORDER BY id DESC');
        if (!rows.length) return sock.sendMessage(jid, { text: '📭 Tidak ada payload.' });
        for (const p of rows) {
          await sock.sendMessage(jid, {
            text: `#${p.id} • ${p.name}\n${p.preview}...`,
            footer: "Payload actions",
            buttons: [
              { buttonId: `.deletepayload ${p.id}`, buttonText: { displayText: '❌ Hapus' }, type: 1 }
            ],
            headerType: 1
          });
        }
        return;
      }

      if (cmd === '.deletepayload') {
        const id = parts[1];
        if (!id) return sock.sendMessage(jid, { text: 'Format: `.deletepayload <ID>`' });
        await db.query('DELETE FROM qris_payloads WHERE id=?', [id]);
        return sock.sendMessage(jid, { text: `🗑 Payload ID ${id} dihapus.` });
      }

      // ---------- DEPOSITS ----------
      if (cmd === '.listdeposit') {
        // optional: .listdeposit status
        const status = parts[1] || '%';
        const [rows] = await db.query('SELECT deposit_id, user_id, username, amount, kode_unik, status, created_at, expired_at FROM deposits WHERE status LIKE ? ORDER BY created_at DESC LIMIT 100', [status]);
        if (!rows.length) return sock.sendMessage(jid, { text: '📭 Tidak ada deposit.' });
        for (const d of rows) {
          await sock.sendMessage(jid, {
            text: `💳 Deposit: ${d.deposit_id}\n👤 ${d.username || d.user_id}\n💵 Rp${d.amount}\nKode unik: ${d.kode_unik}\n📌 Status: ${d.status}\n⏱ Created: ${d.created_at}`,
            footer: "Deposit actions",
            buttons: [
              { buttonId: `.sukses ${d.deposit_id}`, buttonText: { displayText: '✅ Konfirmasi' }, type: 1 },
              { buttonId: `.reject ${d.deposit_id} alasan`, buttonText: { displayText: '🚫 Tolak' }, type: 1 }
            ],
            headerType: 1
          });
        }
        return;
      }

      if (cmd === '.sukses') {
        // .sukses DEPOSIT_ID
        const depositId = parts[1];
        if (!depositId) return sock.sendMessage(jid, { text: 'Format: `.sukses <DEPOSIT_ID>`' });
        const [rows] = await db.query('SELECT * FROM deposits WHERE deposit_id=?', [depositId]);
        if (!rows.length) return sock.sendMessage(jid, { text: `Deposit ${depositId} tidak ditemukan.` });
        const d = rows[0];
        if (d.status !== 'pending' && d.status !== 'waiting') {
          return sock.sendMessage(jid, { text: `Deposit ${depositId} berstatus ${d.status}, tidak bisa di konfirmasi.` });
        }
        // mark success
        await db.query('UPDATE deposits SET status="success", updated_at=NOW() WHERE deposit_id=?', [depositId]);
        // credit user balance
        if (d.user_id) {
          await db.query('UPDATE users SET saldo = saldo + ? WHERE id=?', [d.amount, d.user_id]);
          await db.query('INSERT INTO mutations (user_id,type,amount,balance_after,description,created_at) VALUES (?,?,?,?,?,NOW())',
            [d.user_id, 'credit', d.amount, null, `Deposit ${depositId} confirmed via WA`]);
        }
        await sock.sendMessage(jid, { text: `✅ Deposit ${depositId} berhasil dikonfirmasi.` });
        return;
      }

      if (cmd === '.reject') {
        // .reject DEPOSIT_ID REASON...
        const depositId = parts[1];
        const reason = parts.slice(2).join(' ') || '';
        if (!depositId || !reason) {
          return sock.sendMessage(jid, { text: 'Format: `.reject <DEPOSIT_ID> <ALASAN>`\nContoh: .reject PN-ABC123 Server error' });
        }
        await db.query('UPDATE deposits SET status="rejected", note=?, updated_at=NOW() WHERE deposit_id=?', [reason, depositId]);
        await sock.sendMessage(jid, { text: `🚫 Deposit ${depositId} ditolak. Alasan: ${reason}` });
        return;
      }

      // ---------- SALDO ----------
      if (cmd === '.saldo') {
        const username = parts[1];
        if (!username) return sock.sendMessage(jid, { text: 'Format: `.saldo <USERNAME>`' });
        const [rows] = await db.query('SELECT username,saldo FROM users WHERE username=?', [username]);
        if (!rows.length) return sock.sendMessage(jid, { text: `User ${username} tidak ditemukan.` });
        const u = rows[0];
        return sock.sendMessage(jid, { text: `💰 Saldo ${u.username}: Rp${u.saldo}` });
      }

      if (cmd === '.addsaldo') {
        const username = parts[1];
        const amount = parseInt(parts[2]);
        if (!username || isNaN(amount)) return sock.sendMessage(jid, { text: 'Format: `.addsaldo <USERNAME> <JUMLAH>`' });
        await db.query('UPDATE users SET saldo = saldo + ? WHERE username=?', [amount, username]);
        await db.query('INSERT INTO mutations (user_id,type,amount,description,created_at) SELECT id, "credit", ?, ? , NOW() FROM users WHERE username=?', [amount, `Admin added via WA`, username, username]).catch(()=>{});
        return sock.sendMessage(jid, { text: `✅ Saldo ${username} ditambahkan Rp${amount}` });
      }

      if (cmd === '.minsaldo') {
        const username = parts[1];
        const amount = parseInt(parts[2]);
        if (!username || isNaN(amount)) return sock.sendMessage(jid, { text: 'Format: `.minsaldo <USERNAME> <JUMLAH>`' });
        await db.query('UPDATE users SET saldo = saldo - ? WHERE username=?', [amount, username]);
        await db.query('INSERT INTO mutations (user_id,type,amount,description,created_at) SELECT id, "debit", ?, ? , NOW() FROM users WHERE username=?', [amount, `Admin deducted via WA`, username, username]).catch(()=>{});
        return sock.sendMessage(jid, { text: `✅ Saldo ${username} dikurangi Rp${amount}` });
      }

      // unknown command fallback
      await sock.sendMessage(jid, { text: 'Perintah tidak dikenali. Ketik .help untuk daftar perintah.' });

    } catch (err) {
      console.error('WA handler error', err);
      // send minimal error message to admin (avoid leaking stack)
      try { await sock.sendMessage(msg.key.remoteJid, { text: 'Terjadi kesalahan pada bot. Cek server.' }); } catch(e){}
    }
  });

  return sock;
}

/**
 * notifyAdmins - send deposit notification with interactive buttons
 * depositInfo: { depositId, userId, username, amount }
 */
export async function notifyAdmins(depositInfo) {
  if (!sock) {
    console.warn('WhatsApp socket not initialized');
    return;
  }
  for (const admin of ADMIN_NUMBERS) {
    const jid = admin + '@s.whatsapp.net';
    try {
      await sock.sendMessage(jid, {
        text: `💰 *DEPOSIT BARU*\n\n📌 ID: ${depositInfo.depositId}\n👤 User: ${depositInfo.username || depositInfo.userId}\n💵 Amount: Rp ${depositInfo.amount}`,
        footer: "Pilih aksi untuk deposit ini",
        buttons: [
          { buttonId: `.sukses ${depositInfo.depositId}`, buttonText: { displayText: '✅ Konfirmasi' }, type: 1 },
          { buttonId: `.reject ${depositInfo.depositId} alasan`, buttonText: { displayText: '🚫 Tolak' }, type: 1 },
          { buttonId: `.listdeposit`, buttonText: { displayText: '📜 Semua Deposit' }, type: 1 }
        ],
        headerType: 1
      });
      await db.query('INSERT INTO notifications (admin_number, deposit_id, created_at) VALUES (?,?,NOW())', [admin, depositInfo.depositId]);
    } catch (err) {
      console.error('notifyAdmins error to', jid, err);
    }
  }
}
