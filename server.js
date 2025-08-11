// server.js
import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

import db from './config/db.js';
import { register, login, profile } from './controllers/authController.js';
import { qrisListener } from './controllers/listenerController.js';
import { createDeposit, getDeposit, listDeposits, mutations } from './controllers/depositController.js';
import { initWhatsApp } from './bot/whatsapp.js';
import { authMiddleware } from './middlewares/authMiddleware.js';
import cors from "cors";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth
app.post('/api/register', register);
app.post('/api/login', login);
app.get('/api/profile', authMiddleware, profile);

// Deposit
app.post('/api/deposit', authMiddleware, createDeposit);
app.get('/api/deposit/:depositId', authMiddleware, getDeposit);
app.get('/api/deposits', authMiddleware, listDeposits);

// Mutations
app.get('/api/mutations', authMiddleware, mutations);
app.post('/api/qris/listener', qrisListener);

// optional: list payloads for users
app.get('/api/payloads', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id,name,LEFT(payload_text,120) as preview,created_at FROM payloads ORDER BY id DESC');
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'DB error' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  try {
    await initWhatsApp();
    console.log('WhatsApp bot initialized');
  } catch (err) {
    console.error('Failed to init WhatsApp bot', err);
  }
});
