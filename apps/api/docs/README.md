# Kuvalam API Documentation

## Overview

The Kuvalam AI Workforce Operating System API enables you to build and deploy autonomous AI agents with human-in-the-loop oversight, knowledge augmentation, and multi-tenant isolation.

## Base URL

- **Development**: `http://localhost:3001/api/v1`
- **Production**: `https://api.kuvalam.ai/api/v1`

## Authentication

All authenticated endpoints require a JWT access token delivered via httpOnly cookie:

1. **Register** or **Login** to receive tokens
2. Tokens are automatically included in subsequent requests via cookies
3. Access tokens expire after 15 minutes but refresh automatically via the `/auth/refresh` endpoint

### Example Login Flow

```bash
# Register
curl -X POST http://localhost:3001/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "securepassword",
    "name": "John Doe"
  }'

# Login (cookies are set automatically)
curl -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{
    "email": "user@example.com",
    "password": "securepassword"
  }'

# Use authenticated endpoints with cookies
curl http://localhost:3001/api/v1/auth/me \
  -b cookies.txt
```

## Core Concepts

### Agents
AI agents are autonomous workers that can:
- Execute multi-step tasks with planning and reflection
- Call external tools and APIs
- Access knowledge bases for context
- Request human approval for high-risk actions

### Tasks
Tasks are discrete goals dispatched to agents:
- Automatically queued and executed asynchronously
- Support priorities (LOW, MEDIUM, HIGH)
- Include full execution traces and token usage
- Can include multimodal attachments (images)

### Workflows
Multi-step orchestrations that combine:
- Agent tasks (AGENT, CREW steps)
- HTTP calls and webhooks
- Human approvals (HITL)
- Conditional routing and loops
- Parallel execution

### Knowledge Bases
Vector-indexed document stores that:
- Ingest PDFs, DOCX, TXT, Markdown
- Automatically chunk and embed content
- Provide semantic search for agent context

## Response Format

All responses follow a consistent structure:

```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "requestId": "uuid",
    "timestamp": "2026-07-15T10:30:00Z"
  }
}
```

Errors:

```json
{
  "success": false,
  "error": {
    "code": "AGENT_NOT_FOUND",
    "message": "Agent not found",
    "details": { ... }
  },
  "meta": {
    "requestId": "uuid",
    "timestamp": "2026-07-15T10:30:00Z"
  }
}
```

## Rate Limiting

- **Global**: 200 requests/minute per IP
- **Authentication**: 10 login attempts per 15 minutes
- **Registration**: 5 accounts per hour per IP
- **Task Dispatch**: 20 tasks per minute per tenant

Rate limit headers:
```
X-RateLimit-Limit: 200
X-RateLimit-Remaining: 199
X-RateLimit-Reset: 1626348000
```

## Common Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHENTICATED` | 401 | Missing or invalid authentication token |
| `TENANT_FORBIDDEN` | 403 | User does not have access to this tenant |
| `AGENT_NOT_FOUND` | 404 | Agent does not exist or was deleted |
| `AGENT_NOT_ACTIVE` | 422 | Agent must be activated before use |
| `AGENT_LIMIT_REACHED` | 402 | Plan limit exceeded |
| `TENANT_RATE_LIMITED` | 429 | Too many task dispatches |

## Pagination

List endpoints support pagination via query parameters:

```bash
GET /tenants/{tenantId}/agents?page=2&pageSize=50
```

Response includes pagination metadata:

```json
{
  "data": {
    "agents": [...],
    "pagination": {
      "page": 2,
      "pageSize": 50,
      "total": 247,
      "totalPages": 5
    }
  }
}
```

## Multi-Tenancy

All resource endpoints require a `tenantId` path parameter. The API enforces tenant isolation via:
- **Application-level IDOR guards** on every authenticated request
- **PostgreSQL Row-Level Security (RLS)** at the database layer

Users can only access tenants they are members of (visible in the `/auth/me` response).

## WebSocket Telemetry

Real-time task execution updates are available via WebSocket:

```javascript
const ws = new WebSocket('ws://localhost:3001/telemetry', {
  headers: { 'Authorization': `Bearer ${accessToken}` }
});

ws.onmessage = (event) => {
  const { type, payload } = JSON.parse(event.data);
  console.log(type, payload);
  // Events: agent.task_started, agent.token, agent.tool_call, 
  //         agent.task_completed, workflow.step_started, etc.
};
```

## Interactive Documentation

- **OpenAPI Spec**: [openapi.yaml](./openapi.yaml)
- **Swagger UI**: Coming soon
- **Postman Collection**: Coming soon

## SDK Support

Official SDKs:
- **JavaScript/TypeScript**: `@kuvalam/sdk` (coming soon)
- **Python**: `kuvalam` (coming soon)

## Support

- **Documentation**: https://docs.kuvalam.ai
- **Discord**: https://discord.gg/kuvalam
- **Email**: support@kuvalam.ai
