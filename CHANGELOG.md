# Changelog

All notable changes to the Kuvalam AI Workforce Operating System will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Replaced all console.log statements with structured logging via Pino
- Improved error handling in service layer - errors now fail silently for non-critical operations
- Removed verbose logging from WebSocket telemetry connections

### Added
- Comprehensive OpenAPI 3.1 specification (`apps/api/docs/openapi.yaml`)
- API documentation README with examples and best practices
- GitHub Actions CI/CD pipeline with automated testing
- Security audit checks in CI pipeline

### Fixed
- Logger now properly passed through queue service initialization
- Skill executor console methods now properly disabled in sandbox

## [0.1.0] - 2026-07-15

### Added
- **Core Features**
  - Multi-tenant AI agent deployment with row-level security (RLS)
  - JWT-based authentication with httpOnly cookies and refresh tokens
  - BullMQ-based async task queue with fallback to in-process execution
  - Real-time WebSocket telemetry for agent execution
  - AES-256-GCM credential encryption for connector secrets

- **Agent System**
  - Autonomous agent task execution with plan-execute-reflect loop
  - Multi-step tool calling with 20+ built-in integrations
  - LangGraph-style reflection phase for quality assurance
  - CrewAI-style internal delegation between agents
  - Agent-to-Agent (A2A) protocol for external agent collaboration
  - Episodic and long-term memory for learning from past tasks
  - Custom JavaScript skill execution in isolated sandbox
  - Browser control tool for web automation

- **Workflow Engine**
  - Visual workflow builder with 12+ step types (AGENT, CREW, HTTP, APPROVAL, etc.)
  - Conditional routing with safe expression evaluation
  - Retry policies with exponential backoff and jitter
  - Parallel and sequential execution modes
  - Human-in-the-loop (HITL) approval steps
  - Loop iteration over context arrays
  - Template interpolation with {{variable}} syntax

- **Integrations**
  - OAuth 2.0 flows for Slack, Google, Microsoft, Jira, Salesforce
  - REST API connector with custom authentication
  - Database connectors (PostgreSQL, MySQL, SQL Server, MongoDB, Redis)
  - Model Context Protocol (MCP) server support
  - Webhook inbound triggers
  - Email notifications via SMTP

- **Knowledge Management**
  - Vector-indexed knowledge bases with pgvector
  - Document ingestion (PDF, DOCX, TXT, Markdown, HTML)
  - Semantic search for agent context augmentation
  - S3-compatible storage with local disk fallback

- **Admin & Observability**
  - Comprehensive audit log for compliance
  - Token usage tracking for cost monitoring
  - System health checks and graceful shutdown
  - Plan-based limits (TRIAL, PRO, ENTERPRISE)
  - Tenant analytics dashboard

- **Developer Experience**
  - One-click Render deployment via render.yaml blueprint
  - Docker Compose for local development
  - Comprehensive test suite (15 unit, 3 integration tests)
  - Migration system with automatic discovery
  - Vitest-powered React component tests

- **Security**
  - Helmet security headers
  - Strict CORS policy
  - Rate limiting on sensitive endpoints
  - CSRF protection via SameSite cookies
  - Input validation with Zod schemas
  - SSRF protection for external calls
  - Tenant IDOR guards

### Security
- All SQL queries use parameterized statements (no injection risks)
- Credentials encrypted at rest using scrypt key derivation
- Production secrets strictly enforced (no dev fallbacks)
- Secret scanning via TruffleHog in CI

### Documentation
- Inline code comments explaining complex logic
- Environment variable documentation in `.env.example`
- Docker deployment guides
- API response format standardization

## Release Notes

### Breaking Changes
None (initial release)

### Upgrade Guide
None (initial release)

### Deprecations
None

### Known Issues
- Web app test coverage is limited (component tests only)
- E2E tests not yet implemented
- API documentation not yet served via Swagger UI (OpenAPI spec available)

---

**Legend:**
- `Added` for new features
- `Changed` for changes in existing functionality
- `Deprecated` for soon-to-be removed features
- `Removed` for now removed features
- `Fixed` for any bug fixes
- `Security` in case of vulnerabilities
