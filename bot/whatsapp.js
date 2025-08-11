// bot/whatsapp.js
import baileys, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
const { makeWASocket } = baileys;
import P from 'pino';
import qrcode from 'qrcode-terminal';
import db from '../config/db.js';
import dotenv from 'dotenv';
dotenv.config();

const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || '6283129635860').split(',').map(s => s.trim());
const AUTH_PATH = process.env.WA_AUTH_PATH || './auth_info';
const PRINT_QR = (process.env.SESSION_PRINT_QR || 'true') === 'true';

let sock = null;

function isAdminNumber(number) {
  return ADMIN_NUMBERS.includes(number);
}

export async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    logger: P({ level: 'warn' }),
    printQRInTerminal: false,
    auth: state,
    version,
    browser: ['Bot WA', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr && PRINT_QR) {
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('✅ WhatsApp connected');
    }
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log('❌ WhatsApp disconnected', reason);
      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔄 Reconnecting...');
        initWhatsApp();
      } else {
        console.log('❗ Session expired, delete auth folder and scan QR again.');
      }
    }
  });

  sock.ev.on('messages.upsert', async (mUpsert) => {
    try {
      const messages = mUpsert.messages;
      if (!messages?.length) return;
      const msg = messages[0];
      if (msg.key?.fromMe) return;

      const jid = msg.key.remoteJid;
      const sender = jid.split('@')[0];
      const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
      if (!text) return;

      if (!isAdminNumber(sender)) {
        await sock.sendMessage(jid, { text: 'Anda bukan admin. Akses ditolak.' });
        return;
      }

      const parts = text.split(/\s+/);
      const cmd = parts[0].toLowerCase();

      // ================= COMMAND =================
      if (cmd === '.help') {
        const help = [
          '.help - Menampilkan semua perintah',
          '.createcode <KODE> - Membuat activation code',
          '.listcode - Melihat semua activation code',
          '.deletecode <KODE> - Menghapus activation code',
          '.addpayload <NAMA>|<PAYLOAD> - Menambahkan payload QRIS',
          '.listpayload - Melihat semua payload QRIS',
          '.deletepayload <ID> - Menghapus payload QRIS',
          '.listdeposit [status] - Melihat semua deposit',
          '.sukses <DEPOSIT_ID> - Konfirmasi deposit sukses',
          '.reject <DEPOSIT_ID> <ALASAN> - Menolak deposit',
          '.saldo <USERNAME> - Melihat saldo user',
          '.addsaldo <USERNAME> <JUMLAH> - Menambah saldo user',
          '.minsaldo <USERNAME> <JUMLAH> - Mengurangi saldo user'
        ].join('\n');
        await sock.sendMessage(jid, { text: help });
        return;
      }

      if (cmd === '.createcode') {
        const code = parts[1];
        if (!code) return sock.sendMessage(jid, { text: 'Format salah: .createcode <KODE>' });
        await db.query('INSERT INTO activation_codes (code) VALUES (?)', [code]);
        await sock.sendMessage(jid, { text: `Activation code ${code} berhasil dibuat.` });
      }

      if (cmd === '.listcode') {
        const [rows] = await db.query('SELECT code FROM activation_codes');
        const list = rows.map(r => `- ${r.code}`).join('\n') || 'Tidak ada code.';
        await sock.sendMessage(jid, { text: list });
      }

      if (cmd === '.deletecode') {
        const code = parts[1];
        if (!code) return sock.sendMessage(jid, { text: 'Format salah: .deletecode <KODE>' });
        await db.query('DELETE FROM activation_codes WHERE code=?', [code]);
        await sock.sendMessage(jid, { text: `Activation code ${code} dihapus.` });
      }

      if (cmd === '.addpayload') {
        const payloadData = text.substring(cmd.length).trim();
        const [nama, payload] = payloadData.split('|');
        if (!nama || !payload) return sock.sendMessage(jid, { text: 'Format salah: .addpayload <NAMA>|<PAYLOAD>' });
        await db.query('INSERT INTO qris_payloads (name, payload) VALUES (?, ?)', [nama, payload]);
        await sock.sendMessage(jid, { text: `Payload QRIS ${nama} berhasil ditambahkan.` });
      }

      if (cmd === '.listpayload') {
        const [rows] = await db.query('SELECT id, name FROM qris_payloads');
        const list = rows.map(r => `${r.id}. ${r.name}`).join('\n') || 'Tidak ada payload.';
        await sock.sendMessage(jid, { text: list });
      }

      if (cmd === '.deletepayload') {
        const id = parts[1];
        if (!id) return sock.sendMessage(jid, { text: 'Format salah: .deletepayload <ID>' });
        await db.query('DELETE FROM qris_payloads WHERE id=?', [id]);
        await sock.sendMessage(jid, { text: `Payload QRIS ID ${id} dihapus.` });
      }

      if (cmd === '.listdeposit') {
        const status = parts[1] || '%';
        const [rows] = await db.query('SELECT deposit_id, username, amount, status FROM deposits WHERE status LIKE ?', [status]);
        const list = rows.map(r => `${r.deposit_id} | ${r.username} | Rp${r.amount} | ${r.status}`).join('\n') || 'Tidak ada deposit.';
        await sock.sendMessage(jid, { text: list });
      }

      if (cmd === '.sukses') {
        const depId = parts[1];
        if (!depId) return sock.sendMessage(jid, { text: 'Format salah: .sukses <DEPOSIT_ID>' });
        await db.query('UPDATE deposits SET status="sukses" WHERE deposit_id=?', [depId]);
        const [[dep]] = await db.query('SELECT username, amount FROM deposits WHERE deposit_id=?', [depId]);
        if (dep) {
          await db.query('UPDATE users SET saldo = saldo + ? WHERE username=?', [dep.amount, dep.username]);
          await sock.sendMessage(jid, { text: `Deposit ${depId} sukses. Saldo user ${dep.username} bertambah Rp${dep.amount}` });
        }
      }

      if (cmd === '.reject') {
        const depId = parts[1];
        const alasan = parts.slice(2).join(' ');
        if (!depId || !alasan) return sock.sendMessage(jid, { text: 'Format salah: .reject <DEPOSIT_ID> <ALASAN>' });
        await db.query('UPDATE deposits SET status="reject", note=? WHERE deposit_id=?', [alasan, depId]);
        await sock.sendMessage(jid, { text: `Deposit ${depId} ditolak. Alasan: ${alasan}` });
      }

      if (cmd === '.saldo') {
        const username = parts[1];
        if (!username) return sock.sendMessage(jid, { text: 'Format salah: .saldo <USERNAME>' });
        const [[user]] = await db.query('SELECT saldo FROM users WHERE username=?', [username]);
        if (user) {
          await sock.sendMessage(jid, { text: `Saldo ${username}: Rp${user.saldo}` });
        } else {
          await sock.sendMessage(jid, { text: 'User tidak ditemukan.' });
        }
      }

      if (cmd === '.addsaldo') {
        const username = parts[1];
        const jumlah = parseInt(parts[2]);
        if (!username || isNaN(jumlah)) return sock.sendMessage(jid, { text: 'Format salah: .addsaldo <USERNAME> <JUMLAH>' });
        await db.query('UPDATE users SET saldo = saldo + ? WHERE username=?', [jumlah, username]);
        await sock.sendMessage(jid, { text: `Saldo ${username} bertambah Rp${jumlah}` });
      }

      if (cmd === '.minsaldo') {
        const username = parts[1];
        const jumlah = parseInt(parts[2]);
        if (!username || isNaN(jumlah)) return sock.sendMessage(jid, { text: 'Format salah: .minsaldo <USERNAME> <JUMLAH>' });
        await db.query('UPDATE users SET saldo = saldo - ? WHERE username=?', [jumlah, username]);
        await sock.sendMessage(jid, { text: `Saldo ${username} berkurang Rp${jumlah}` });
      }

    } catch (err) {
      console.error('WA handler error', err);
    }
  });

  return sock;
}

export async function notifyAdmins(depositInfo) {
  if (!sock) {
    console.warn('WhatsApp socket not initialized');
    return;
  }
  for (const admin of ADMIN_NUMBERS) {
    const jid = admin + '@s.whatsapp.net';
    const txt = `NEW DEPOSIT\nDepositID: ${depositInfo.depositId}\nUser: ${depositInfo.username || depositInfo.userId}\nAmount: Rp ${depositInfo.amount}\n\nUntuk konfirmasi: .sukses ${depositInfo.depositId}\nUntuk reject: .reject ${depositInfo.depositId} <reason>`;
    try {
      await sock.sendMessage(jid, { text: txt });
      await db.query('INSERT INTO notifications (admin_number, deposit_id) VALUES (?,?)', [admin, depositInfo.depositId]);
    } catch (err) {
      console.error('notify failed', err);
    }
  }
}
