-- Add used_at column to refresh_tokens for token rotation and theft detection
-- Migration 013: Refresh token rotation support

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_used_at ON refresh_tokens(used_at) WHERE used_at IS NOT NULL;

-- Add comment
COMMENT ON COLUMN refresh_tokens.used_at IS 'Timestamp when the token was used for refresh. Used for token rotation and theft detection.';
