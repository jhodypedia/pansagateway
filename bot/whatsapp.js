// bot/whatsapp.js
import baileys, {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} from '@whiskeysockets/baileys';
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
        if (qr && PRINT_QR) qrcode.generate(qr, { small: true });
        if (connection === 'open') console.log('✅ WhatsApp connected');
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
            const msg = mUpsert.messages?.[0];
            if (!msg || msg.key?.fromMe) return;

            const jid = msg.key.remoteJid;
            if (jid.includes('@g.us')) return;

            const sender = jid.split('@')[0];
            if (!isAdminNumber(sender)) return;

            const text = (msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                '').trim();
            if (!text) return;

            const parts = text.split(/\s+/);
            const cmd = parts[0].toLowerCase();

            // Menu utama
            if (cmd === '.menu') {
                return sock.sendMessage(jid, { text: 
`📌 *Admin Menu*
.code         → Kelola kode aktivasi
.payload      → Kelola payload QRIS
.deposit      → Kelola deposit
.user         → Kelola user`
                });
            }

            // ===================== ACTIVATION CODE =====================
            if (cmd === '.code') {
                return sock.sendMessage(jid, { text: 
`🔑 *Activation Code Commands*
.listcode                 → Lihat semua kode
.createcode <KODE>        → Buat kode baru
.deletecode <KODE>        → Hapus kode` 
                });
            }
            if (cmd === '.createcode') {
                const code = parts[1];
                if (!code) return sock.sendMessage(jid, { text: 'Format: .createcode <KODE>' });
                await db.query('INSERT INTO activation_codes (code) VALUES (?)', [code]);
                return sock.sendMessage(jid, { text: `✅ Code ${code} dibuat.` });
            }
            if (cmd === '.listcode') {
                const [rows] = await db.query('SELECT code FROM activation_codes');
                const list = rows.map(r => `- ${r.code}`).join('\n') || 'Tidak ada code.';
                return sock.sendMessage(jid, { text: list });
            }
            if (cmd === '.deletecode') {
                const code = parts[1];
                if (!code) return sock.sendMessage(jid, { text: 'Format: .deletecode <KODE>' });
                await db.query('DELETE FROM activation_codes WHERE code=?', [code]);
                return sock.sendMessage(jid, { text: `🗑 Code ${code} dihapus.` });
            }

            // ===================== PAYLOAD QRIS =====================
            if (cmd === '.payload') {
                return sock.sendMessage(jid, { text:
`📦 *Payload Commands*
.listpayload                          → Lihat semua payload
.addpayload <NAMA>|<PAYLOAD>          → Tambah payload baru
.deletepayload <ID>                   → Hapus payload`
                });
            }
            if (cmd === '.addpayload') {
                const payloadData = text.substring(cmd.length).trim();
                const [nama, payload] = payloadData.split('|');
                if (!nama || !payload) return sock.sendMessage(jid, { text: 'Format: .addpayload <NAMA>|<PAYLOAD>' });
                await db.query('INSERT INTO qris_payloads (name, payload) VALUES (?, ?)', [nama, payload]);
                return sock.sendMessage(jid, { text: `✅ Payload ${nama} ditambahkan.` });
            }
            if (cmd === '.listpayload') {
                const [rows] = await db.query('SELECT id, name FROM qris_payloads');
                const list = rows.map(r => `${r.id}. ${r.name}`).join('\n') || 'Tidak ada payload.';
                return sock.sendMessage(jid, { text: list });
            }
            if (cmd === '.deletepayload') {
                const id = parts[1];
                if (!id) return sock.sendMessage(jid, { text: 'Format: .deletepayload <ID>' });
                await db.query('DELETE FROM qris_payloads WHERE id=?', [id]);
                return sock.sendMessage(jid, { text: `🗑 Payload ID ${id} dihapus.` });
            }

            // ===================== DEPOSIT =====================
            if (cmd === '.deposit') {
                return sock.sendMessage(jid, { text:
`💰 *Deposit Commands*
.listdeposit [status]               → Lihat semua deposit
.sukses <DEPOSIT_ID>                 → Konfirmasi sukses
.reject <DEPOSIT_ID> <ALASAN>        → Tolak deposit`
                });
            }
            if (cmd === '.listdeposit') {
                const status = parts[1] || '%';
                const [rows] = await db.query('SELECT deposit_id, username, amount, status FROM deposits WHERE status LIKE ?', [status]);
                const list = rows.map(r => `${r.deposit_id} | ${r.username} | Rp${r.amount} | ${r.status}`).join('\n') || 'Tidak ada deposit.';
                return sock.sendMessage(jid, { text: list });
            }
            if (cmd === '.sukses') {
                const depId = parts[1];
                if (!depId) return sock.sendMessage(jid, { text: 'Format: .sukses <DEPOSIT_ID>' });
                await db.query('UPDATE deposits SET status="sukses" WHERE deposit_id=?', [depId]);
                const [[dep]] = await db.query('SELECT username, amount FROM deposits WHERE deposit_id=?', [depId]);
                if (dep) {
                    await db.query('UPDATE users SET saldo = saldo + ? WHERE username=?', [dep.amount, dep.username]);
                    return sock.sendMessage(jid, { text: `✅ Deposit ${depId} sukses. Saldo ${dep.username} +Rp${dep.amount}` });
                }
            }
            if (cmd === '.reject') {
                const depId = parts[1];
                const alasan = parts.slice(2).join(' ');
                if (!depId || !alasan) return sock.sendMessage(jid, { text: 'Format: .reject <DEPOSIT_ID> <ALASAN>' });
                await db.query('UPDATE deposits SET status="reject", note=? WHERE deposit_id=?', [alasan, depId]);
                return sock.sendMessage(jid, { text: `❌ Deposit ${depId} ditolak. Alasan: ${alasan}` });
            }

            // ===================== USERS =====================
            if (cmd === '.user') {
                return sock.sendMessage(jid, { text:
`👥 *User Commands*
.listuser                             → Lihat semua user
.adduser <USERNAME> <EMAIL> <PASS>    → Tambah user baru
.deleteuser <USERNAME>                → Hapus user`
                });
            }
            if (cmd === '.listuser') {
                const [rows] = await db.query('SELECT username, email, saldo FROM users');
                const list = rows.map(r => `${r.username} | ${r.email} | Rp${r.saldo}`).join('\n') || 'Tidak ada user.';
                return sock.sendMessage(jid, { text: list });
            }
            if (cmd === '.adduser') {
                const [username, email, password] = parts.slice(1);
                if (!username || !email || !password) return sock.sendMessage(jid, { text: 'Format: .adduser <USERNAME> <EMAIL> <PASSWORD>' });
                await db.query('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [username, email, password]);
                return sock.sendMessage(jid, { text: `✅ User ${username} dibuat.` });
            }
            if (cmd === '.deleteuser') {
                const username = parts[1];
                if (!username) return sock.sendMessage(jid, { text: 'Format: .deleteuser <USERNAME>' });
                await db.query('DELETE FROM users WHERE username=?', [username]);
                return sock.sendMessage(jid, { text: `🗑 User ${username} dihapus.` });
            }

        } catch (err) {
            console.error('WA handler error', err);
        }
    });

    return sock;
}

export async function notifyAdmins(depositInfo) {
    if (!sock) return console.warn('WhatsApp socket not initialized');
    for (const admin of ADMIN_NUMBERS) {
        const jid = admin + '@s.whatsapp.net';
        const txt = 
`💰 *NEW DEPOSIT*
🆔 DepositID: ${depositInfo.depositId}
👤 User: ${depositInfo.username || depositInfo.userId}
💵 Amount: Rp ${depositInfo.amount}

✅ Konfirmasi: .sukses ${depositInfo.depositId}
❌ Tolak: .reject ${depositInfo.depositId} <alasan>`;
        try {
            await sock.sendMessage(jid, { text: txt });
            await db.query('INSERT INTO notifications (admin_number, deposit_id) VALUES (?,?)', [admin, depositInfo.depositId]);
        } catch (err) {
            console.error('notify failed', err);
        }
    }
}
