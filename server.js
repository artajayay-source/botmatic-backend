/**
 * BotMatic UMKM — Backend API Server v4.0
 * Stack: Node.js + Express + Supabase Auth + Baileys (WhatsApp) + Claude AI
 *
 * ARSITEKTUR AUTH:
 * - Semua endpoint /api/* (kecuali /api/health, /api/auth/*) butuh JWT
 * - JWT dikirim via header: Authorization: Bearer <token>
 * - Backend pakai service key → bypass RLS Supabase
 * - Verifikasi JWT via supabase.auth.getUser(token)
 *
 * ARSITEKTUR BAILEYS:
 * - Setiap bisnis punya 1 sesi Baileys (1 nomor WA)
 * - Sesi disimpan di TEMP/botmatic-sessions/{businessId}/
 * - Auth files di-backup ke Supabase (baileys_backup column) agar survive restart
 * - sessions Map menyimpan state in-memory: { sock, qr, connected, waNumber }
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  getContentType,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser
} from '@whiskeysockets/baileys';
import NodeCache from 'node-cache';
import pino from 'pino';
import QRCode from 'qrcode';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ============================================================
// CLIENTS
// ============================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Client untuk verifikasi JWT user (pakai anon key)
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY
);

// ============================================================
// MIDDLEWARE: Verifikasi JWT
// Pakai di semua route yang butuh login
// ============================================================
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token tidak ditemukan. Silahkan login terlebih dahulu.' });
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Token tidak valid atau sudah kadaluarsa. Silahkan login ulang.' });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    res.status(401).json({ error: 'Autentikasi gagal.' });
  }
}

// ============================================================
// MIDDLEWARE: Rate Limiter sederhana
// Max 100 request per menit per IP
// ============================================================
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxReq = 100;

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return next();
  }

  const entry = rateLimitMap.get(ip);
  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + windowMs;
    return next();
  }

  entry.count++;
  if (entry.count > maxReq) {
    return res.status(429).json({ error: 'Terlalu banyak request. Coba lagi dalam 1 menit.' });
  }
  next();
}

// Bersihkan rate limit map setiap 5 menit
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

app.use(rateLimit);

const claude = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Silent pino logger (Baileys sangat verbose, kita bungkam)
const logger = pino({ level: 'silent' });

// Directory untuk menyimpan auth files Baileys sementara
const SESSIONS_DIR = path.join(process.env.TEMP || process.env.TMP || '/tmp', 'botmatic-sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ============================================================
// IN-MEMORY SESSION MAP
// Key: businessId (string)
// Value: { sock, qr (base64 data URL), connected (bool), waNumber, reconnectAttempts }
// ============================================================
const sessions = new Map();

// ============================================================
// MULTER — untuk upload file (extract produk via AI)
// Max 10MB, simpan di memory (bukan disk) → langsung ke Claude
// ============================================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
      'application/pdf',
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format file tidak didukung. Gunakan JPG, PNG, PDF, CSV, atau Excel.'));
    }
  }
});

// ============================================================
// SERVE FRONTEND (BotMatic_App.html)
// ============================================================
const FRONTEND_PATH = path.join(__dirname, 'BotMatic_App.html');
app.get('/', (req, res) => {
  if (fs.existsSync(FRONTEND_PATH)) {
    res.sendFile(FRONTEND_PATH);
  } else {
    res.send('<h2>BotMatic API running. Frontend file not found.</h2>');
  }
});

// ============================================================
// HEALTH CHECK (publik)
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'BotMatic API running',
    version: '4.0.0',
    activeSessions: sessions.size,
    time: new Date().toISOString()
  });
});

// ============================================================
// EXTRACT PRODUCTS VIA AI (publik — bisa dipanggil sebelum login selesai onboarding)
// POST /api/extract-products
// Body: multipart/form-data dengan field "file"
// Return: { products: [{name, price, description}], raw_text, total }
// ============================================================
app.post('/api/extract-products', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File tidak ditemukan. Pilih file untuk diupload.' });
    }

    const { mimetype, buffer, originalname } = req.file;
    const isImage = mimetype.startsWith('image/');
    const isPDF = mimetype === 'application/pdf';
    const isText = mimetype === 'text/plain' || mimetype === 'text/csv';
    const isExcel = mimetype.includes('excel') || mimetype.includes('spreadsheetml');

    let claudeMessages = [];

    if (isImage) {
      // Kirim gambar langsung ke Claude Vision
      const base64 = buffer.toString('base64');
      const mediaType = mimetype === 'image/jpg' ? 'image/jpeg' : mimetype;
      claudeMessages = [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 }
            },
            {
              type: 'text',
              text: `Ini adalah gambar dari menu/katalog/daftar produk sebuah bisnis.
Tolong ekstrak SEMUA produk/menu/layanan yang ada di gambar ini.
Format output HARUS berupa JSON array seperti ini:
{
  "products": [
    {"name": "Nama Produk", "price": "$15", "description": "Deskripsi singkat jika ada"},
    ...
  ]
}
Aturan:
- Harga: salin PERSIS seperti yang tertulis di gambar, termasuk simbol mata uang (contoh: "$15", "Rp 25.000", "25rb", "15k")
- Jangan ubah format harga — jika ada $ tulis $, jika ada Rp tulis Rp
- Jika harga tidak ada di gambar, isi dengan ""
- Deskripsi: ambil dari gambar jika ada, jika tidak ada isi ""
- Ambil SEMUA item yang terlihat, jangan lewatkan satupun
- Jika ada kategori/kelompok, tetap sertakan semua item dalam products array
- Output HANYA JSON, tidak ada teks lain`
            }
          ]
        }
      ];
    } else if (isPDF) {
      // PDF: konversi ke base64 dan kirim sebagai document
      const base64 = buffer.toString('base64');
      claudeMessages = [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 }
            },
            {
              type: 'text',
              text: `Ini adalah dokumen PDF dari menu/katalog/daftar produk/price list sebuah bisnis.
Tolong ekstrak SEMUA produk/menu/layanan yang ada di dokumen ini.
Format output HARUS berupa JSON array seperti ini:
{
  "products": [
    {"name": "Nama Produk", "price": "Rp 25.000", "description": "Deskripsi singkat jika ada"},
    ...
  ]
}
Aturan:
- Harga: salin PERSIS seperti yang tertulis di dokumen, termasuk simbol mata uang (contoh: "$15", "Rp 25.000", "25rb", "15k")
- Jangan ubah format harga — jika ada $ tulis $, jika ada Rp tulis Rp
- Jika harga tidak ada, isi dengan ""
- Deskripsi: ambil dari dokumen jika ada, jika tidak isi ""
- Ambil SEMUA item, jangan lewatkan satupun
- Output HANYA JSON, tidak ada teks lain`
            }
          ]
        }
      ];
    } else {
      // CSV / Excel / TXT — baca sebagai teks
      let textContent = buffer.toString('utf-8');
      // Batasi ke 20000 karakter
      if (textContent.length > 20000) textContent = textContent.substring(0, 20000) + '\n...(dipotong)';

      claudeMessages = [
        {
          role: 'user',
          content: `Ini adalah data produk/menu dari file "${originalname}" (${mimetype}):

${textContent}

Tolong ekstrak SEMUA produk/menu/layanan yang ada dalam data ini.
Format output HARUS berupa JSON:
{
  "products": [
    {"name": "Nama Produk", "price": "25000", "description": "Deskripsi jika ada"},
    ...
  ]
}
Aturan:
- Harga: salin PERSIS seperti yang tertulis, termasuk simbol mata uang (contoh: "$15", "Rp 25.000", "25rb")
- Jangan ubah format harga
- Jika harga tidak ada, isi dengan ""
- Output HANYA JSON, tidak ada teks lain`
        }
      ];
    }

    // Panggil Claude
    const response = await claude.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      messages: claudeMessages
    });

    const rawText = response.content[0]?.text || '';

    // Parse JSON dari response
    let products = [];
    try {
      // Ekstrak JSON dari response (kadang Claude menambahkan markdown code blocks)
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        products = parsed.products || [];
      }
    } catch (parseErr) {
      console.error('Parse error:', parseErr.message);
      return res.status(422).json({
        error: 'AI tidak bisa membaca produk dari file ini. Pastikan file berisi daftar produk yang jelas.',
        raw: rawText.substring(0, 500)
      });
    }

    if (products.length === 0) {
      return res.status(422).json({
        error: 'Tidak ada produk yang ditemukan dalam file. Pastikan file berisi nama produk dan harga.',
        raw: rawText.substring(0, 500)
      });
    }

    // Bersihkan dan validasi data produk
    const cleanProducts = products
      .filter(p => p.name && p.name.trim())
      .map(p => ({
        name: String(p.name).trim().substring(0, 200),
        price: String(p.price || '').trim().substring(0, 50), // Simpan persis termasuk simbol ($, Rp, dll)
        description: String(p.description || '').trim().substring(0, 500)
      }));

    res.json({
      success: true,
      total: cleanProducts.length,
      products: cleanProducts,
      filename: originalname
    });

  } catch (err) {
    console.error('extract-products error:', err);
    if (err.message?.includes('Format file')) {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File terlalu besar. Maksimal 10MB.' });
    }
    res.status(500).json({ error: 'Gagal memproses file. Coba lagi atau gunakan format lain.' });
  }
});

// ============================================================
// AUTH ROUTES (publik — tidak butuh JWT)
// ============================================================

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, fullName } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email dan password wajib diisi.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password minimal 6 karakter.' });
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      user_metadata: { full_name: fullName || '' },
      email_confirm: true
    });

    if (error) {
      if (error.message.includes('already registered')) {
        return res.status(400).json({ error: 'Email sudah terdaftar. Silahkan login.' });
      }
      return res.status(400).json({ error: error.message });
    }

    // Sign in langsung setelah register
    const { data: signInData, error: signInError } = await supabaseAuth.auth.signInWithPassword({ email, password });
    if (signInError) return res.status(400).json({ error: signInError.message });

    res.json({
      success: true,
      user: { id: data.user.id, email: data.user.email },
      session: signInData.session,
      message: 'Akun berhasil dibuat!'
    });

  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Terjadi kesalahan saat mendaftar.' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email dan password wajib diisi.' });
    }

    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });

    if (error) {
      if (error.message.includes('Invalid login')) {
        return res.status(401).json({ error: 'Email atau password salah.' });
      }
      return res.status(401).json({ error: error.message });
    }

    res.json({
      success: true,
      user: { id: data.user.id, email: data.user.email },
      session: data.session,
      message: 'Login berhasil!'
    });

  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Terjadi kesalahan saat login.' });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    await supabaseAuth.auth.admin.signOut(token);
    res.json({ success: true, message: 'Logout berhasil.' });
  } catch (err) {
    res.json({ success: true });
  }
});

// GET /api/auth/me — cek session aktif
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    const { data: businesses } = await supabase
      .from('businesses')
      .select('id, name, category, is_connected')
      .eq('user_id', req.user.id);

    res.json({
      user: { id: req.user.id, email: req.user.email },
      profile: profile || null,
      businesses: businesses || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: POST /api/onboarding  [AUTH REQUIRED]
// Menerima data dari wizard frontend, generate AI scripts, simpan ke Supabase
// ============================================================
app.post('/api/onboarding', requireAuth, async (req, res) => {
  try {
    const { businessInfo, products, brandVoice, hours, faq } = req.body;

    if (!businessInfo?.name || !businessInfo?.category) {
      return res.status(400).json({ error: 'Nama dan kategori bisnis wajib diisi' });
    }

    // 1. Simpan data bisnis ke Supabase (dengan user_id dari JWT)
    const { data: business, error: bizError } = await supabase
      .from('businesses')
      .insert({
        user_id: req.user.id,
        name: businessInfo.name,
        category: businessInfo.category,
        description: businessInfo.description || '',
        location: businessInfo.location || '',
        instagram: businessInfo.instagram || '',
        email: businessInfo.email || '',
        hours_open: hours?.open || '08:00',
        hours_close: hours?.close || '21:00',
        days_open: hours?.days || 'Senin-Sabtu',
        brand_voice: brandVoice || 'santai',
        faq: faq || []
      })
      .select()
      .single();

    if (bizError) throw bizError;

    // 2. Simpan produk
    if (products && products.length > 0) {
      const productRows = products.map((p, i) => ({
        business_id: business.id,
        name: p.name,
        price: p.price ? parseInt(p.price.toString().replace(/\D/g, '')) : null,
        description: p.description || '',
        sort_order: i
      }));

      const { error: prodError } = await supabase.from('products').insert(productRows);
      if (prodError) console.error('Products insert error:', prodError);
    }

    // 3. Generate AI scripts menggunakan Claude
    const scripts = await generateScripts({ business, products: products || [], faq: faq || [] });

    // 4. Simpan scripts ke Supabase
    const scriptRows = Object.entries(scripts)
      .filter(([k]) => !k.startsWith('_'))
      .map(([type, content]) => ({
        business_id: business.id,
        script_type: type,
        content: content
      }));

    const { error: scriptError } = await supabase.from('scripts').insert(scriptRows);
    if (scriptError) console.error('Scripts insert error:', scriptError);

    await logUsage(business.id, scripts._tokensUsed || 0, 0, 'script_generate');

    res.json({
      success: true,
      businessId: business.id,
      scripts: scripts,
      message: 'Bisnis berhasil didaftarkan dan script AI sudah dibuat!'
    });

  } catch (err) {
    console.error('Onboarding error:', err);
    res.status(500).json({ error: err.message || 'Terjadi kesalahan server' });
  }
});

// ============================================================
// ROUTE: Serve frontend HTML
// ============================================================
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'BotMatic_App.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.send('<h1>BotMatic API Running</h1><p>Frontend not found at: ' + htmlPath + '</p>');
  }
});

// ============================================================
// ROUTE: GET /api/business/:id  [AUTH REQUIRED]
// ============================================================
app.get('/api/business/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const [bizResult, scriptsResult, statsResult] = await Promise.all([
      supabase.from('businesses').select('*').eq('id', id).single(),
      supabase.from('scripts').select('*').eq('business_id', id).eq('is_active', true),
      supabase.from('messages').select('id', { count: 'exact' }).eq('business_id', id)
    ]);

    if (bizResult.error) return res.status(404).json({ error: 'Bisnis tidak ditemukan' });

    res.json({
      business: bizResult.data,
      scripts: scriptsResult.data || [],
      totalMessages: statsResult.count || 0
    });

  } catch (err) {
    console.error('Get business error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: POST /api/setup-device  [AUTH REQUIRED]
// ============================================================
app.post('/api/setup-device', requireAuth, async (req, res) => {
  try {
    const { businessId, waNumber, businessName } = req.body;

    if (!businessId || !waNumber) {
      return res.status(400).json({ error: 'businessId dan waNumber wajib diisi' });
    }

    const formattedNumber = formatWANumber(waNumber);

    // Update nomor WA di database
    await supabase.from('businesses').update({
      wa_number: formattedNumber,
      updated_at: new Date().toISOString()
    }).eq('id', businessId);

    // Jika sesi sudah ada dan connected, kembalikan status
    const existing = sessions.get(businessId);
    if (existing?.connected) {
      return res.json({
        success: true,
        status: 'already_connected',
        waNumber: formattedNumber,
        message: 'WhatsApp sudah terhubung!'
      });
    }

    // Mulai sesi Baileys baru (async — QR akan tersedia di sessions Map)
    createSession(businessId, formattedNumber).catch(err => {
      console.error(`createSession error for ${businessId}:`, err.message);
    });

    res.json({
      success: true,
      status: 'qr_pending',
      waNumber: formattedNumber,
      message: 'Sesi dimulai. Poll /api/get-qr/' + businessId + ' untuk mendapatkan QR code.'
    });

  } catch (err) {
    console.error('Setup device error:', err.message);
    res.status(500).json({ error: 'Gagal setup device', detail: err.message });
  }
});

// ============================================================
// ROUTE: GET /api/get-qr/:businessId  [AUTH REQUIRED]
// ============================================================
app.get('/api/get-qr/:businessId', requireAuth, async (req, res) => {
  const { businessId } = req.params;
  const session = sessions.get(businessId);

  if (!session) {
    return res.json({ status: 'no_session', qr: null });
  }

  if (session.connected) {
    return res.json({ status: 'connected', qr: null });
  }

  if (session.qr) {
    return res.json({ status: 'qr_ready', qr: session.qr, qrRaw: session.qrRaw });
  }

  res.json({ status: 'loading', qr: null });
});

// ============================================================
// ROUTE: GET /api/check-connection/:businessId  [AUTH REQUIRED]
// ============================================================
app.get('/api/check-connection/:businessId', requireAuth, async (req, res) => {
  try {
    const { businessId } = req.params;

    // Cek in-memory session dulu (paling akurat)
    const session = sessions.get(businessId);
    if (session?.connected) {
      return res.json({ connected: true, status: 'connected' });
    }

    // Fallback: cek database
    const { data: business } = await supabase
      .from('businesses')
      .select('wa_number, is_connected')
      .eq('id', businessId)
      .single();

    if (!business) return res.status(404).json({ error: 'Bisnis tidak ditemukan' });

    res.json({
      connected: business.is_connected || false,
      status: business.is_connected ? 'connected' : 'disconnected'
    });

  } catch (err) {
    console.error('Check connection error:', err.message);
    res.json({ connected: false, status: 'error' });
  }
});

// ============================================================
// ROUTE: POST /api/disconnect/:businessId  [AUTH REQUIRED]
// ============================================================
app.post('/api/disconnect/:businessId', requireAuth, async (req, res) => {
  const { businessId } = req.params;

  try {
    const session = sessions.get(businessId);
    if (session?.sock) {
      await session.sock.logout();
    }
    sessions.delete(businessId);

    // Hapus auth files lokal
    const sessionDir = path.join(SESSIONS_DIR, businessId);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    // Update database
    await supabase.from('businesses').update({
      is_connected: false,
      baileys_backup: null
    }).eq('id', businessId);

    res.json({ success: true, message: 'WhatsApp berhasil diputus' });

  } catch (err) {
    console.error('Disconnect error:', err.message);
    // Tetap hapus dari Map meskipun logout gagal
    sessions.delete(businessId);
    res.json({ success: true, message: 'Sesi dihapus' });
  }
});

// ============================================================
// ROUTE: GET /api/conversations/:businessId  [AUTH REQUIRED]
// ============================================================
app.get('/api/conversations/:businessId', requireAuth, async (req, res) => {
  try {
    const { businessId } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;

    const { data, error, count } = await supabase
      .from('conversations')
      .select('*', { count: 'exact' })
      .eq('business_id', businessId)
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({ conversations: data, total: count });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: GET /api/messages/:conversationId  [AUTH REQUIRED]
// ============================================================
app.get('/api/messages/:conversationId', requireAuth, async (req, res) => {
  try {
    const { conversationId } = req.params;

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json({ messages: data });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: POST /api/send-message  [AUTH REQUIRED]
// ============================================================
app.post('/api/send-message', requireAuth, async (req, res) => {
  try {
    const { businessId, customerWa, message } = req.body;

    const business = await getBusiness(businessId);
    if (!business) return res.status(404).json({ error: 'Bisnis tidak ditemukan' });

    const sent = await sendWhatsAppMessage(businessId, customerWa, message);

    if (sent) {
      const conversation = await getOrCreateConversation(businessId, customerWa, '');
      await supabase.from('messages').insert({
        conversation_id: conversation.id,
        business_id: businessId,
        direction: 'out',
        content: message,
        is_ai_generated: false
      });
    }

    res.json({ success: sent });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// BAILEYS: createSession
// Buat koneksi WhatsApp baru untuk satu bisnis
// ============================================================
async function createSession(businessId, waNumber) {
  console.log(`[${businessId}] createSession() started`);
  const sessionDir = path.join(SESSIONS_DIR, businessId);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  // Restore session dari Supabase jika ada backup
  await restoreSessionFromSupabase(businessId, sessionDir);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  console.log(`[${businessId}] Auth state loaded`);

  // NodeCache untuk retry counter — wajib untuk prevent "No sessions" error
  const msgRetryCounterCache = new NodeCache();

  // Gunakan versi hardcoded agar tidak hang saat fetch ke server WA
  let version = [2, 3000, 1015901307];
  try {
    const versionResult = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
    ]);
    version = versionResult.version;
    console.log(`[${businessId}] WA version fetched: ${version}`);
  } catch (e) {
    console.log(`[${businessId}] Using hardcoded WA version: ${version}`);
  }

  console.log(`[${businessId}] Creating socket...`);
  const sock = makeWASocket({
    version,
    logger,
    // makeCacheableSignalKeyStore: cache signal session keys in-memory
    // → mencegah "No sessions" error saat kirim pesan ke kontak baru
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    msgRetryCounterCache,
    printQRInTerminal: false,
    browser: ['BotMatic', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    retryRequestDelayMs: 350,
    maxMsgRetryCount: 5
  });
  console.log(`[${businessId}] Socket created, waiting for QR...`);

  // Inisialisasi entry di sessions Map
  sessions.set(businessId, {
    sock,
    qr: null,
    connected: false,
    waNumber,
    reconnectAttempts: 0
  });

  // ---- EVENT: connection.update ----
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const session = sessions.get(businessId);
    if (!session) return;

    // QR code baru muncul → simpan raw string + data URL
    if (qr) {
      try {
        console.log(`[${businessId}] QR string length: ${qr.length}, preview: ${qr.substring(0, 50)}`);
        const qrDataUrl = await QRCode.toDataURL(qr, {
          width: 512,
          margin: 2,
          errorCorrectionLevel: 'L',
          type: 'image/png'
        });
        session.qr = qrDataUrl;
        session.qrRaw = qr;
        console.log(`[${businessId}] QR ready`);
      } catch (err) {
        console.error(`[${businessId}] QR generation error:`, err.message);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[${businessId}] Connection closed. Code: ${statusCode}. Reconnect: ${shouldReconnect}`);

      session.connected = false;
      session.qr = null;

      if (statusCode === DisconnectReason.loggedOut) {
        // User logged out — hapus sesi sepenuhnya
        sessions.delete(businessId);
        fs.rmSync(sessionDir, { recursive: true, force: true });

        await supabase.from('businesses').update({
          is_connected: false,
          baileys_backup: null
        }).eq('id', businessId);

      } else if (shouldReconnect && session.reconnectAttempts < 5) {
        // Reconnect dengan exponential backoff
        session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
        const delay = Math.min(5000 * session.reconnectAttempts, 30000);
        console.log(`[${businessId}] Reconnecting in ${delay}ms (attempt ${session.reconnectAttempts})`);
        setTimeout(() => createSession(businessId, waNumber), delay);
      } else {
        sessions.delete(businessId);
        await supabase.from('businesses').update({ is_connected: false }).eq('id', businessId);
      }
    }

    if (connection === 'open') {
      console.log(`[${businessId}] ✅ WhatsApp connected!`);
      session.connected = true;
      session.qr = null;
      session.reconnectAttempts = 0;

      // Update database
      await supabase.from('businesses').update({
        is_connected: true,
        connected_at: new Date().toISOString()
      }).eq('id', businessId);

      // Kirim pesan selamat datang
      try {
        const { data: biz } = await supabase
          .from('businesses')
          .select('name')
          .eq('id', businessId)
          .single();

        if (biz && waNumber) {
          await sendWhatsAppMessage(
            businessId,
            waNumber,
            `✅ *BotMatic aktif!*\n\nHalo! Bot AI untuk *${biz.name}* sudah siap melayani pelanggan 24/7.\n\nCoba minta seseorang kirim "halo" ke nomor ini untuk test bot kamu! 🤖`
          );
        }
      } catch (e) {
        console.error(`[${businessId}] Welcome message error:`, e.message);
      }
    }
  });

  // ---- EVENT: creds.update ---- Simpan credentials & backup ke Supabase
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    // Backup ke Supabase secara async (jangan blokir)
    backupSessionToSupabase(businessId, sessionDir).catch(err =>
      console.error(`[${businessId}] Backup error:`, err.message)
    );
  });

  // ---- EVENT: messages.upsert ---- Pesan masuk dari pelanggan
  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return;

    for (const msg of msgs) {
      // Abaikan pesan dari diri sendiri atau broadcast
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;

      await processIncomingBaileysMessage(businessId, msg, sock).catch(err =>
        console.error(`[${businessId}] processIncoming error:`, err.message)
      );
    }
  });

  return sock;
}

// ============================================================
// BAILEYS: processIncomingBaileysMessage
// Proses pesan masuk dari pelanggan → generate AI reply → kirim balik
// ============================================================
async function processIncomingBaileysMessage(businessId, msg, sock) {
  try {
    // Ekstrak teks dari berbagai jenis pesan
    const contentType = getContentType(msg.message);
    let text = '';

    if (contentType === 'conversation') {
      text = msg.message.conversation;
    } else if (contentType === 'extendedTextMessage') {
      text = msg.message.extendedTextMessage?.text;
    } else if (contentType === 'imageMessage') {
      text = msg.message.imageMessage?.caption || '';
    } else {
      // Abaikan voice note, document, sticker, dll
      return;
    }

    if (!text || text.trim() === '') return;

    // Normalisasi JID — WhatsApp baru pakai @lid untuk privasi
    // Baileys tidak bisa kirim ke @lid, harus dikonversi ke @s.whatsapp.net
    let rawJid = msg.key.remoteJid;
    let senderJid;
    if (rawJid.endsWith('@lid')) {
      // Konversi @lid → @s.whatsapp.net pakai nomor yang sama
      const number = rawJid.split('@')[0];
      senderJid = `${number}@s.whatsapp.net`;
      console.log(`[${businessId}] @lid JID dikonversi: ${rawJid} → ${senderJid}`);
    } else {
      try {
        senderJid = jidNormalizedUser(rawJid);
      } catch {
        senderJid = rawJid;
      }
    }

    const senderWa = senderJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
    const senderName = msg.pushName || 'Kak';

    console.log(`[${businessId}] Pesan dari ${senderWa}: ${text.substring(0, 50)}`);

    // 1. Ambil data bisnis
    const { data: business, error: bizError } = await supabase
      .from('businesses')
      .select('*, scripts(*), products(*)')
      .eq('id', businessId)
      .eq('is_connected', true)
      .single();

    if (bizError || !business) {
      console.log(`[${businessId}] Business not found or not connected`);
      return;
    }

    if (business.status === 'expired') {
      await sock.sendMessage(senderJid, {
        text: 'Maaf, layanan bot sedang tidak aktif. Silahkan hubungi pemilik toko secara langsung.'
      });
      return;
    }

    // 2. Cari/buat conversation
    const conversation = await getOrCreateConversation(business.id, senderWa, senderName);

    // 3. Simpan pesan masuk
    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      business_id: business.id,
      direction: 'in',
      content: text.trim(),
      wa_message_id: msg.key.id || null
    });

    // Tandai pesan sudah dibaca
    await sock.readMessages([msg.key]);

    // Tampilkan "sedang mengetik..." selama generate AI
    await sock.sendPresenceUpdate('composing', senderJid);

    // 4. Generate AI reply
    let aiReply;
    try {
      aiReply = await generateAIReply({
        business,
        customerMessage: text.trim(),
        customerName: senderName,
        conversationHistory: conversation.context || []
      });
    } catch (aiErr) {
      console.error(`[${businessId}] generateAIReply gagal:`, aiErr.message);
      aiReply = { content: `Halo ${senderName}! Terima kasih sudah menghubungi kami. Ada yang bisa kami bantu? 😊`, tokensUsed: 0, inputTokens: 0, outputTokens: 0 };
    }

    // 5. Kirim balasan
    await sock.sendPresenceUpdate('paused', senderJid);
    await sock.sendMessage(senderJid, { text: aiReply.content });

    // 6. Simpan balasan ke database
    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      business_id: business.id,
      direction: 'out',
      content: aiReply.content,
      is_ai_generated: true,
      ai_tokens_used: aiReply.tokensUsed
    });

    // 7. Update conversation context (simpan 20 entry = 10 bolak-balik)
    const newContext = [
      ...(conversation.context || []),
      { role: 'user', content: text.trim() },
      { role: 'assistant', content: aiReply.content }
    ].slice(-20);

    await supabase
      .from('conversations')
      .update({
        context: newContext,
        last_message: text.trim(),
        message_count: (conversation.message_count || 0) + 1,
        updated_at: new Date().toISOString()
      })
      .eq('id', conversation.id);

    // 8. Log usage tokens
    await logUsage(business.id, aiReply.inputTokens, aiReply.outputTokens, 'chat_reply');

  } catch (err) {
    console.error(`processIncomingBaileysMessage error [${businessId}]:`, err.message);
  }
}

// ============================================================
// BAILEYS: sendWhatsAppMessage
// Kirim pesan via Baileys session
// ============================================================
async function sendWhatsAppMessage(businessId, targetNumber, message) {
  try {
    const session = sessions.get(businessId);
    if (!session?.sock || !session?.connected) {
      console.error(`[${businessId}] sendWhatsAppMessage: session not connected`);
      return false;
    }

    // Format JID Baileys
    let jid = targetNumber.replace(/\D/g, '');
    if (jid.startsWith('0')) jid = '62' + jid.slice(1);
    if (!jid.startsWith('62')) jid = '62' + jid;
    jid = jid + '@s.whatsapp.net';

    await session.sock.sendMessage(jid, { text: message });
    return true;

  } catch (err) {
    console.error(`sendWhatsAppMessage error [${businessId}]:`, err.message);
    return false;
  }
}

// ============================================================
// BAILEYS: backupSessionToSupabase
// Backup semua auth files ke kolom baileys_backup di Supabase
// ============================================================
async function backupSessionToSupabase(businessId, sessionDir) {
  try {
    if (!fs.existsSync(sessionDir)) return;

    const files = fs.readdirSync(sessionDir);
    const backup = {};

    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        backup[file] = fs.readFileSync(filePath, 'utf8');
      }
    }

    await supabase.from('businesses').update({
      baileys_backup: JSON.stringify(backup)
    }).eq('id', businessId);

  } catch (err) {
    console.error(`backupSessionToSupabase error [${businessId}]:`, err.message);
  }
}

// ============================================================
// BAILEYS: restoreSessionFromSupabase
// Restore auth files dari Supabase ke filesystem sebelum createSession
// ============================================================
async function restoreSessionFromSupabase(businessId, sessionDir) {
  try {
    const { data: business } = await supabase
      .from('businesses')
      .select('baileys_backup')
      .eq('id', businessId)
      .single();

    if (!business?.baileys_backup) return;

    const backup = JSON.parse(business.baileys_backup);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    for (const [filename, content] of Object.entries(backup)) {
      fs.writeFileSync(path.join(sessionDir, filename), content, 'utf8');
    }

    console.log(`[${businessId}] Session restored from Supabase (${Object.keys(backup).length} files)`);

  } catch (err) {
    console.error(`restoreSessionFromSupabase error [${businessId}]:`, err.message);
  }
}

// ============================================================
// BAILEYS: restoreActiveSessions
// Dipanggil saat server start — reload semua bisnis yang is_connected=true
// ============================================================
async function restoreActiveSessions() {
  try {
    const { data: businesses, error } = await supabase
      .from('businesses')
      .select('id, wa_number, name')
      .eq('is_connected', true);

    if (error || !businesses?.length) {
      console.log('No active sessions to restore');
      return;
    }

    console.log(`Restoring ${businesses.length} active session(s)...`);

    for (const biz of businesses) {
      try {
        await createSession(biz.id, biz.wa_number);
        console.log(`[${biz.id}] Session restore started (${biz.name})`);
        // Jeda kecil antar sesi agar tidak overwhelm
        await new Promise(r => setTimeout(r, 1500));
      } catch (err) {
        console.error(`Failed to restore session [${biz.id}]:`, err.message);
      }
    }

  } catch (err) {
    console.error('restoreActiveSessions error:', err.message);
  }
}

// ============================================================
// HELPER: Generate AI Scripts (saat onboarding)
// ============================================================
async function generateScripts({ business, products, faq }) {
  const voiceConfig = {
    santai: { desc: 'ramah, santai, pakai emoji sesekali, bahasa sehari-hari', greeting: 'Halo' },
    formal: { desc: 'profesional, sopan, formal, tidak pakai emoji berlebihan', greeting: 'Selamat datang' },
    gaul: { desc: 'kekinian, gaul, pakai bahasa Gen Z, emoji banyak', greeting: 'Hai bestie' },
    mewah: { desc: 'eksklusif, elegan, premium, bahasa halus dan mewah', greeting: 'Selamat datang' }
  };

  const voice = voiceConfig[business.brand_voice] || voiceConfig.santai;
  const productList = products.map(p =>
    `- ${p.name}${p.price ? ` (${p.price})` : ''}${p.description ? `: ${p.description}` : ''}`
  ).join('\n');

  const faqText = faq.map((f, i) => `${i+1}. Q: ${f.q}\n   A: ${f.a}`).join('\n');

  const prompt = `Kamu adalah copywriter WhatsApp untuk UMKM Indonesia. Buat 6 template pesan WhatsApp untuk bisnis berikut:

NAMA BISNIS: ${business.name}
KATEGORI: ${business.category}
DESKRIPSI: ${business.description || '-'}
LOKASI: ${business.location || '-'}
JAM BUKA: ${business.hours_open} - ${business.hours_close} (${business.days_open})
GAYA BICARA: ${voice.desc}

PRODUK/MENU:
${productList || '(belum ada produk)'}

FAQ:
${faqText || '(belum ada FAQ)'}

Buat 6 template berikut dalam format JSON:
{
  "greeting": "Pesan sambutan pertama kali/sapa pelanggan baru",
  "products": "Pesan daftar produk/menu/layanan lengkap",
  "order": "Pesan panduan cara order/pesan",
  "operational": "Pesan info jam buka, lokasi, cara menghubungi",
  "faq": "Pesan jawaban pertanyaan umum",
  "followup": "Pesan follow-up untuk pelanggan yang sudah selesai transaksi"
}

PENTING:
- Setiap pesan maksimal 300 karakter
- Sesuaikan gaya bicara: ${voice.desc}
- Sapa dengan "${voice.greeting}"
- Gunakan nama bisnis yang sebenarnya
- Hanya kembalikan JSON valid, tidak ada teks lain`;

  try {
    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const content = response.content[0].text.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI tidak menghasilkan JSON valid');

    const scripts = JSON.parse(jsonMatch[0]);
    scripts._tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
    return scripts;

  } catch (err) {
    console.error('generateScripts error:', err);
    return {
      greeting: `${voice.greeting} di ${business.name}! 😊 Ada yang bisa kami bantu?`,
      products: `Ini produk kami:\n${productList || 'Hubungi kami untuk info lengkap'}`,
      order: `Cara order:\n1. Pilih produk\n2. Konfirmasi ke kami\n3. Bayar & barang dikirim`,
      operational: `Jam buka: ${business.hours_open}-${business.hours_close} (${business.days_open})\nLokasi: ${business.location || '-'}`,
      faq: `FAQ:\n${faqText || 'Hubungi kami untuk pertanyaan lebih lanjut'}`,
      followup: `Terima kasih sudah berbelanja di ${business.name}! 🙏 Jangan lupa review ya!`,
      _tokensUsed: 0
    };
  }
}

// ============================================================
// HELPER: Generate AI Reply untuk chat masuk
// ============================================================
async function generateAIReply({ business, customerMessage, customerName, conversationHistory }) {
  const scripts = business.scripts || [];
  const scriptMap = {};
  scripts.forEach(s => { scriptMap[s.script_type] = s.content; });

  const recentHistory = conversationHistory.slice(-10);

  // Susun daftar produk dari tabel products
  const productItems = business.products || [];
  const productList = productItems.length > 0
    ? productItems.map(p => `- ${p.name}${p.price ? ` (${p.price})` : ''}${p.description ? `: ${p.description}` : ''}`).join('\n')
    : (scriptMap.products || 'Hubungi kami untuk info produk');

  const systemPrompt = `Kamu adalah asisten WhatsApp AI untuk ${business.name}, sebuah bisnis ${business.category} di Indonesia.

KARAKTER KAMU:
- Nama: Bot ${business.name}
- Gaya bicara: ${business.brand_voice} (${getVoiceDesc(business.brand_voice)})
- Ramah, helpful, fokus pada kebutuhan pelanggan

INFORMASI BISNIS:
- Jam buka: ${business.hours_open} - ${business.hours_close} (${business.days_open})
- Lokasi: ${business.location || 'hubungi kami untuk info lokasi'}
- Cara order: ${business.order_method || 'hubungi kami langsung'}

DAFTAR PRODUK/MENU (WAJIB gunakan data ini saat ditanya harga):
${productList}

TEMPLATE PESAN (gunakan sebagai referensi):
Greeting: ${scriptMap.greeting || '-'}
Order: ${scriptMap.order || '-'}
Operasional: ${scriptMap.operational || '-'}
FAQ: ${scriptMap.faq || '-'}
Follow-up: ${scriptMap.followup || '-'}

ATURAN PENTING:
1. Jawab dalam bahasa Indonesia
2. Maksimal 200 kata per balasan
3. Sesuaikan gaya bicara dengan karakter
4. Jika ditanya sesuatu yang tidak kamu tahu, sarankan hubungi pemilik langsung
5. Jangan pernah berpura-pura jadi manusia, kamu adalah bot AI
6. Sapa pelanggan dengan "${customerName}"
7. WAJIB: Tulis harga PERSIS seperti yang tertulis di daftar produk di atas — jangan konversi, jangan ubah format, jangan ganti mata uang. Jika tertulis $15 maka tulis $15, jika Rp 50.000 maka tulis Rp 50.000.`;

  try {
    const messages = [
      ...recentHistory,
      { role: 'user', content: customerMessage }
    ];

    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: systemPrompt,
      messages: messages
    });

    return {
      content: response.content[0].text.trim(),
      tokensUsed: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0
    };

  } catch (err) {
    console.error('generateAIReply error:', err);
    const intent = detectIntent(customerMessage);
    const fallbacks = {
      greeting: scriptMap.greeting || `Halo ${customerName}! Ada yang bisa saya bantu?`,
      products: scriptMap.products || 'Maaf, info produk sedang tidak tersedia.',
      order: scriptMap.order || 'Untuk pemesanan, silahkan hubungi kami langsung.',
      operational: scriptMap.operational || `Jam buka kami: ${business.hours_open}-${business.hours_close}`,
      default: `Halo ${customerName}! Terima kasih sudah menghubungi ${business.name}. Ada yang bisa kami bantu? 😊`
    };

    return {
      content: fallbacks[intent] || fallbacks.default,
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0
    };
  }
}

// ============================================================
// HELPER: Cari atau buat conversation
// ============================================================
async function getOrCreateConversation(businessId, customerWa, customerName) {
  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('business_id', businessId)
    .eq('customer_wa', customerWa)
    .single();

  if (existing) return existing;

  const { data: newConv } = await supabase
    .from('conversations')
    .insert({
      business_id: businessId,
      customer_wa: customerWa,
      customer_name: customerName || '',
      context: []
    })
    .select()
    .single();

  return newConv;
}

// ============================================================
// HELPER: Ambil data bisnis
// ============================================================
async function getBusiness(id) {
  const { data } = await supabase.from('businesses').select('*').eq('id', id).single();
  return data;
}

// ============================================================
// HELPER: Log penggunaan AI
// ============================================================
async function logUsage(businessId, tokensIn, tokensOut, action) {
  try {
    const costUsd = (tokensIn / 1_000_000 * 0.25) + (tokensOut / 1_000_000 * 1.25);
    await supabase.from('usage_logs').insert({
      business_id: businessId,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
      action: action
    });
  } catch (err) {
    console.error('logUsage error:', err.message);
  }
}

// ============================================================
// HELPER: Deteksi intent dari pesan
// ============================================================
function detectIntent(message) {
  const msg = message.toLowerCase();

  if (/^(halo|hai|hi|hello|selamat|permisi|assalam|p+a+g+i|sore|malam|siang)/.test(msg)) return 'greeting';
  if (/(menu|produk|katalog|jual|ada apa|daftar|pilihan|harga|price)/.test(msg)) return 'products';
  if (/(order|pesan|beli|mau|minta|booking|kirim|delivery)/.test(msg)) return 'order';
  if (/(jam|buka|tutup|lokasi|alamat|dimana|kapan)/.test(msg)) return 'operational';

  return 'default';
}

// ============================================================
// HELPER: Format nomor WA
// ============================================================
function formatWANumber(number) {
  let num = number.replace(/\D/g, '');
  if (num.startsWith('0')) num = '62' + num.slice(1);
  if (!num.startsWith('62')) num = '62' + num;
  return num;
}

// ============================================================
// HELPER: Deskripsi brand voice
// ============================================================
function getVoiceDesc(voice) {
  const map = {
    santai: 'ramah dan santai, pakai emoji sesekali',
    formal: 'profesional dan sopan',
    gaul: 'kekinian dan gaul, bahasa Gen Z',
    mewah: 'elegan dan eksklusif'
  };
  return map[voice] || map.santai;
}

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🤖 BotMatic API v3.0 running on port ${PORT}`);
  console.log(`🧠 Claude API: ${process.env.ANTHROPIC_API_KEY ? '✓ configured' : '✗ MISSING'}`);
  console.log(`🗄️  Supabase: ${process.env.SUPABASE_URL ? '✓ configured' : '✗ MISSING'}`);

  // Restore semua sesi WhatsApp yang aktif sebelum restart
  console.log('🔄 Restoring active WhatsApp sessions...');
  await restoreActiveSessions();
});

export default app;
