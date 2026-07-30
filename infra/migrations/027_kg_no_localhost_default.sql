-- ═══════════════════════════════════════════════════════════════════════════════
-- Drop localhost defaults on knowledge_graphs — cloud deployments need explicit hosts
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE knowledge_graphs ALTER COLUMN host DROP DEFAULT;

-- Any existing rows with 'localhost' keep their value — this only affects new inserts.
-- Newly created graphs must provide an explicit host or rely on NEO4J_HOST env var.