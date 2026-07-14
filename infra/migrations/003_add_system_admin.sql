-- ============================================================
-- Migration: 003_add_system_admin.sql
-- Adds is_system_admin column to existing users table.
-- Safe to run on existing databases — uses ADD COLUMN IF NOT EXISTS.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_system_admin BOOLEAN NOT NULL DEFAULT FALSE;
