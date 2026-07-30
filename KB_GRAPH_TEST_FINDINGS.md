# Knowledge Base & Graph Testing — Findings & Bugs
**Date**: 2026-07-30  
**Data**: Motability_POLICY_LSM_MAPPING.xlsx (4 sheets → 4 CSV files)  
**Tester**: Browser-based full flow testing

---

## Summary of Test Flow
1. ✅ Located & converted `Motability_POLICY_LSM_MAPPING.xlsx` → 4 CSV files
2. ✅ Started API (port 3001) and Web (port 3000) services
3. ✅ Created KB "Motability LSM Mapping" via browser UI
4. ✅ Uploaded 4 CSV files (432-row LSM mapping, overview, audit columns, version)
5. ❌ All 4 documents FAILED processing (embedding generation broken)
6. ❌ Semantic Query Tool — returns no results (no indexed chunks)
7. ❌ Knowledge Graph DB Import — Neo4j auth failure (401/429)
8. ✅ Agent KB/Graph linking — UI works correctly
9. ⚠️ Chat page — shows "select organization" even when logged in

---

## 🔴 CRITICAL: CSV Document Processing Fails (Embedding API)

**Issue**: All uploaded CSV documents get marked `FAILED` with `0/1 chunks indexed`.

**Root Cause**: The `embed()` function in `apps/api/src/services/llm.service.js:278` calls OpenAI's `text-embedding-3-large` model via the tenant's configured `llmConfig`. The configured provider does not support this model or has no valid API key.

**Files Involved**:
- `apps/api/src/services/llm.service.js:278-289` — embed function hardcodes `text-embedding-3-large`
- `apps/api/src/services/knowledge.service.js:217-260` — processDocument calls embed() in batches

**Fix Needed**:
1. Allow tenants to configure a dedicated embedding provider/model (separate from LLM provider)
2. Fall back to a local embedding model (e.g., Ollama `nomic-embed-text`) when OpenAI is unavailable
3. Add better error surfacing in the UI — currently users see "FAILED" with no explanation

---

## 🔴 CRITICAL: Knowledge Graph DB Import Fails (Neo4j Auth)

**Issue**: Importing PostgreSQL tables to Neo4j knowledge graph fails with:
- `401 Unauthorized: Invalid credential`
- `429 Too many failed authentication requests`

**Root Cause**: Neo4j is running but the default credentials (`neo4j` / no password) are incorrect. The password likely needs to be set or retrieved from the environment.

**Files Involved**:
- `apps/api/src/services/knowledge-graph.service.js:25` — creates graph with default `username: 'neo4j'` but no password
- `apps/api/src/services/graph-db-importer.service.js` — uses the graph's stored credentials

**Fix Needed**:
1. Retrieve Neo4j password from env vars or auto-provisioned state
2. Store the actual password in `knowledge_graphs` table on creation
3. Add credential validation on graph creation with user-friendly error

---

## 🟡 MEDIUM: Semantic Query Returns Silent Empty Results

**Issue**: When no documents are indexed, the Semantic Query Tool shows nothing — no "No results found" message. The UI stays blank after clicking Search.

**Files Involved**:
- `apps/web/src/app/dashboard/knowledge/page.tsx:1071-1095` — Semantic Query Tool section

**Fix Needed**: Show a "No indexed documents in this collection" or "No results found" message when search returns empty.

---

## 🟡 MEDIUM: Chat Page Shows "Select Organization" While Logged In

**Issue**: Navigating to `/dashboard/chat` shows "Chat is organization-specific. Please select an organization." even though the user is logged in with tenant `acme`.

**Fix Needed**: The Chat page should automatically use the current tenant context or show available agents immediately.

---

## 🟡 MEDIUM: Doc Count Mismatch (UI)

**Issue**: The Motability LSM Mapping KB shows "4 docs" on the Knowledge page sidebar but "8 docs" on the Agent configuration page checkbox.

**Likely Cause**: The agent config page may be counting chunks or using a different aggregation query.

---

## 🟢 MINOR: CSS React Warning — border/borderTop Conflict

**Issue**: Console warning: "a style property during rerender (border) when a conflicting property is set (borderTop)"

**Files Involved**: `apps/web/src/components/WorkflowCanvas.tsx`

**Fix Needed**: Use explicit `borderTop`, `borderLeft`, etc. instead of shorthand `border` when individual border properties are also set.

---

## 🟢 MINOR: KB Upload Doesn't Support .xlsx

**Issue**: The file upload only accepts `.pdf, .docx, .txt, .md, .csv`. Users with Excel files must manually convert to CSV first.

**Files Involved**:
- `apps/api/src/routes/knowledge.routes.js:7-15` — ALLOWED_UPLOAD_EXTENSIONS
- `apps/web/src/app/dashboard/knowledge/page.tsx` — accept attribute

**Fix Needed**: Add `.xlsx` and `.xls` to allowed extensions and add xlsx extraction to `document-extractor.service.js`.

---

## ✅ What Works

| Feature | Status |
|---------|--------|
| KB Creation | ✅ Works |
| KG Creation | ✅ Works |
| File Upload (CSV) | ✅ Works |
| File Upload Progress Bar | ✅ Works |
| Multi-file Upload | ✅ Works |
| Agent → KB Linking | ✅ Works |
| Agent → KG Linking | ✅ Works |
| Agent Configuration Save | ✅ Works |
| Document List with Status | ✅ Works |
| Reprocess/Reprocess All Buttons | ✅ Works (but fails due to embedding) |
| DB Schema Discovery | ✅ Works (shows 41 tables) |
| DB Import Modal with Table Selection | ✅ Works |
| Knowledge Graph List/Detail View | ✅ Works |
| Command Palette (⌘K) | ✅ Works |
