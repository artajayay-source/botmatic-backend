-- ============================================================
-- BotMatic Auth Migration
-- Jalankan di Supabase SQL Editor
-- ============================================================

-- 1. Tambah kolom user_id ke tabel businesses
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. Index agar query per user cepat
CREATE INDEX IF NOT EXISTS idx_businesses_user_id ON businesses(user_id);

-- 3. Enable Row Level Security di semua tabel
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE scripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RLS POLICIES: businesses
-- ============================================================
DROP POLICY IF EXISTS "Users see own businesses" ON businesses;
CREATE POLICY "Users see own businesses"
  ON businesses FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users insert own businesses" ON businesses;
CREATE POLICY "Users insert own businesses"
  ON businesses FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own businesses" ON businesses;
CREATE POLICY "Users update own businesses"
  ON businesses FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users delete own businesses" ON businesses;
CREATE POLICY "Users delete own businesses"
  ON businesses FOR DELETE
  USING (auth.uid() = user_id);

-- Service role bypass (untuk backend server pakai service key)
DROP POLICY IF EXISTS "Service role full access businesses" ON businesses;
CREATE POLICY "Service role full access businesses"
  ON businesses FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- RLS POLICIES: products
-- ============================================================
DROP POLICY IF EXISTS "Users see own products" ON products;
CREATE POLICY "Users see own products"
  ON products FOR SELECT
  USING (
    business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Users manage own products" ON products;
CREATE POLICY "Users manage own products"
  ON products FOR ALL
  USING (
    business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Service role full access products" ON products;
CREATE POLICY "Service role full access products"
  ON products FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- RLS POLICIES: scripts
-- ============================================================
DROP POLICY IF EXISTS "Users see own scripts" ON scripts;
CREATE POLICY "Users see own scripts"
  ON scripts FOR SELECT
  USING (
    business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Users manage own scripts" ON scripts;
CREATE POLICY "Users manage own scripts"
  ON scripts FOR ALL
  USING (
    business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Service role full access scripts" ON scripts;
CREATE POLICY "Service role full access scripts"
  ON scripts FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- RLS POLICIES: conversations
-- ============================================================
DROP POLICY IF EXISTS "Users see own conversations" ON conversations;
CREATE POLICY "Users see own conversations"
  ON conversations FOR SELECT
  USING (
    business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Service role full access conversations" ON conversations;
CREATE POLICY "Service role full access conversations"
  ON conversations FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- RLS POLICIES: messages
-- ============================================================
DROP POLICY IF EXISTS "Users see own messages" ON messages;
CREATE POLICY "Users see own messages"
  ON messages FOR SELECT
  USING (
    business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Service role full access messages" ON messages;
CREATE POLICY "Service role full access messages"
  ON messages FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- RLS POLICIES: usage_logs
-- ============================================================
DROP POLICY IF EXISTS "Users see own usage" ON usage_logs;
CREATE POLICY "Users see own usage"
  ON usage_logs FOR SELECT
  USING (
    business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Service role full access usage_logs" ON usage_logs;
CREATE POLICY "Service role full access usage_logs"
  ON usage_logs FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- 4. Tabel user_profiles (opsional: simpan nama, plan, dll)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'premium')),
  plan_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own profile" ON user_profiles;
CREATE POLICY "Users see own profile"
  ON user_profiles FOR SELECT
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users update own profile" ON user_profiles;
CREATE POLICY "Users update own profile"
  ON user_profiles FOR UPDATE
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "Service role full access profiles" ON user_profiles;
CREATE POLICY "Service role full access profiles"
  ON user_profiles FOR ALL
  USING (auth.role() = 'service_role');

-- 5. Auto-create profile saat user daftar
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_profiles (id, full_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1))
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- SELESAI
-- Catatan penting:
-- - Backend pakai SUPABASE_SERVICE_KEY → bypass semua RLS (aman)
-- - Frontend pakai anon key + user JWT → kena RLS (terlindungi)
-- ============================================================
