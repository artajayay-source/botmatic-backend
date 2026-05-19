-- ============================================================
-- BotMatic — Migrasi v2 → v3 (Fonnte → Baileys)
-- Jalankan sekali di Supabase SQL Editor
-- ============================================================

-- 1. Tambah kolom baileys_backup untuk menyimpan session Baileys
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS baileys_backup TEXT;

-- 2. Hapus kolom Fonnte yang tidak diperlukan lagi
--    (opsional — boleh dibiarkan agar data lama tidak hilang)
-- ALTER TABLE businesses DROP COLUMN IF EXISTS fonnte_device;

-- 3. Verifikasi struktur tabel
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'businesses'
ORDER BY ordinal_position;
