-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Confirm setup
SELECT 'Extensions enabled: uuid-ossp, vector, pg_trgm' AS status;
