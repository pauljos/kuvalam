-- Migration 019: RLS for custom_models table
-- This table had tenant_id but was missing RLS — the only tenant-scoped table
-- in the system without DB-level enforcement. Application code already filters
-- by tenant_id, but this adds defense-in-depth at the database level.

ALTER TABLE custom_models ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS custom_models_tenant_isolation ON custom_models;
CREATE POLICY custom_models_tenant_isolation ON custom_models
  USING (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS custom_models_tenant_insert ON custom_models;
CREATE POLICY custom_models_tenant_insert ON custom_models
  FOR INSERT WITH CHECK (tenant_id = current_tenant_id());
