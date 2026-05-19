-- ============================================================
-- BotMatic UMKM — Supabase Database Schema
-- Jalankan di Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABLE: businesses
-- Menyimpan data usaha UMKM yang daftar
-- ============================================================
CREATE TABLE IF NOT EXISTS businesses (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),

  -- Info bisnis dasar
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,         -- kuliner, fashion, jasa, retail, dll
  description   TEXT,
  location      TEXT,
  instagram     TEXT,
  email         TEXT,

  -- Jam operasional
  hours_open    TEXT DEFAULT '08:00',
  hours_close   TEXT DEFAULT '21:00',
  days_open     TEXT DEFAULT 'Senin-Sabtu',

  -- Brand voice
  brand_voice   TEXT DEFAULT 'santai',  -- santai, formal, gaul, mewah

  -- WhatsApp connection (Baileys)
  wa_number       TEXT UNIQUE,           -- nomor WA yang diconnect
  is_connected    BOOLEAN DEFAULT FALSE,
  connected_at    TIMESTAMPTZ,
  baileys_backup  TEXT,                  -- JSON backup auth files Baileys (untuk restore setelah restart)

  -- Status akun
  status        TEXT DEFAULT 'trial',  -- trial, active, expired
  trial_ends_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days'),

  -- FAQ custom
  faq           JSONB DEFAULT '[]'::jsonb
);

-- ============================================================
-- TABLE: products
-- Produk/menu/layanan dari bisnis
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),

  name          TEXT NOT NULL,
  price         BIGINT,               -- harga dalam Rupiah
  description   TEXT,
  is_available  BOOLEAN DEFAULT TRUE,
  sort_order    INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_products_business ON products(business_id);

-- ============================================================
-- TABLE: scripts
-- AI-generated scripts untuk setiap bisnis
-- ============================================================
CREATE TABLE IF NOT EXISTS scripts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),

  script_type   TEXT NOT NULL,        -- greeting, products, order, operational, faq, followup
  content       TEXT NOT NULL,
  is_active     BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_scripts_business ON scripts(business_id);
CREATE INDEX IF NOT EXISTS idx_scripts_type ON scripts(business_id, script_type);

-- ============================================================
-- TABLE: conversations
-- Setiap percakapan WhatsApp unik (per nomor pelanggan)
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),

  customer_wa   TEXT NOT NULL,        -- nomor WA pelanggan
  customer_name TEXT,                 -- nama pelanggan (dari Fonnte)
  status        TEXT DEFAULT 'active', -- active, closed
  last_message  TEXT,
  message_count INT DEFAULT 0,

  -- Context untuk AI (JSON array of last messages)
  context       JSONB DEFAULT '[]'::jsonb,

  UNIQUE(business_id, customer_wa)
);

CREATE INDEX IF NOT EXISTS idx_conversations_business ON conversations(business_id);
CREATE INDEX IF NOT EXISTS idx_conversations_customer ON conversations(customer_wa);

-- ============================================================
-- TABLE: messages
-- Semua pesan yang masuk dan keluar
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),

  direction       TEXT NOT NULL,      -- 'in' (dari pelanggan) atau 'out' (dari bot)
  content         TEXT NOT NULL,
  wa_message_id   TEXT,               -- ID pesan dari WhatsApp/Fonnte
  is_ai_generated BOOLEAN DEFAULT FALSE,
  ai_tokens_used  INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_business ON messages(business_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

-- ============================================================
-- TABLE: usage_logs
-- Tracking penggunaan AI tokens per bisnis (untuk billing)
-- ============================================================
CREATE TABLE IF NOT EXISTS usage_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  logged_at     TIMESTAMPTZ DEFAULT NOW(),

  tokens_in     INT DEFAULT 0,        -- input tokens Claude
  tokens_out    INT DEFAULT 0,        -- output tokens Claude
  cost_usd      NUMERIC(10,6) DEFAULT 0,
  action        TEXT                  -- 'chat_reply', 'script_generate', dll
);

CREATE INDEX IF NOT EXISTS idx_usage_business ON usage_logs(business_id);
CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_logs(logged_at DESC);

-- ============================================================
-- FUNCTION: update updated_at otomatis
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER businesses_updated_at
  BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER scripts_updated_at
  BEFORE UPDATE ON scripts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY (RLS) — aktifkan untuk production
-- ============================================================
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE scripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;

-- Policy: backend service role bisa akses semua (pakai service_role key)
-- Policy ini membolehkan server kita baca/tulis semua data
CREATE POLICY "service_role_all" ON businesses FOR ALL USING (true);
CREATE POLICY "service_role_all" ON products FOR ALL USING (true);
CREATE POLICY "service_role_all" ON scripts FOR ALL USING (true);
CREATE POLICY "service_role_all" ON conversations FOR ALL USING (true);
CREATE POLICY "service_role_all" ON messages FOR ALL USING (true);
CREATE POLICY "service_role_all" ON usage_logs FOR ALL USING (true);

-- ============================================================
-- SAMPLE DATA — untuk testing (opsional, hapus di production)
-- ============================================================
/*
INSERT INTO businesses (name, category, description, location, hours_open, hours_close, brand_voice, wa_number)
VALUES (
  'Warung Makan Bu Sari',
  'kuliner',
  'Warung makan rumahan dengan menu masakan Jawa',
  'Jakarta Selatan',
  '08:00', '21:00',
  'santai',
  '6281234567890'
);
*/
