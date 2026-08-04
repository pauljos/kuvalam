// ═══════════════════════════════════════════════════════════════════════════════
// Shared Validation Schemas — Fastify JSON Schema definitions
// ═══════════════════════════════════════════════════════════════════════════════

export const uuidParam = {
  type: 'object',
  properties: {
    tenantId: { type: 'string', format: 'uuid' }
  },
  required: ['tenantId']
}

export const agentIdParam = {
  type: 'object',
  properties: {
    tenantId: { type: 'string', format: 'uuid' },
    agentId: { type: 'string', format: 'uuid' }
  },
  required: ['tenantId', 'agentId']
}

export const createAgentSchema = {
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 255 },
      description: { type: 'string', maxLength: 1000 },
      systemPrompt: { type: 'string', maxLength: 10000 },
      llmProvider: { type: 'string', maxLength: 50 },
      llmModel: { type: 'string', maxLength: 100 },
      autonomyLevel: { type: 'string', enum: ['SUPERVISED', 'GUARDED', 'AUTONOMOUS'] },
      archetype: { type: 'string', maxLength: 100 },
      dataStrategy: { type: 'string', enum: ['source', 'target', 'both', 'none'] },
    }
  }
}

export const updateAgentSchema = {
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 255 },
      description: { type: 'string', maxLength: 1000 },
      systemPrompt: { type: 'string', maxLength: 10000 },
      llmProvider: { type: 'string', maxLength: 50 },
      llmModel: { type: 'string', maxLength: 100 },
      autonomyLevel: { type: 'string', enum: ['SUPERVISED', 'GUARDED', 'AUTONOMOUS'] },
      confidenceThreshold: { type: 'number', minimum: 0, maximum: 1 },
      reportDir: { type: 'string', maxLength: 500 },
      archetype: { type: 'string', maxLength: 100 },
      dataStrategy: { type: 'string', enum: ['source', 'target', 'both', 'none'] },
    }
  }
}

export const dispatchTaskSchema = {
  body: {
    type: 'object',
    required: ['goal'],
    properties: {
      goal: { type: 'string', minLength: 1, maxLength: 100000 },
      priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
      context: { type: 'object' }
    }
  }
}

export const createConnectorSchema = {
  body: {
    type: 'object',
    required: ['name', 'toolId'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 255 },
      toolId: { type: 'string', minLength: 1, maxLength: 100 },
      config: { type: 'object' }
    }
  }
}

export const createWorkflowSchema = {
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 255 },
      description: { type: 'string', maxLength: 1000 },
      steps: { type: 'array', maxItems: 100 },
      triggers: { type: 'array', maxItems: 10 }
    }
  }
}

export const createKBSchema = {
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 255 },
      description: { type: 'string', maxLength: 1000 }
    }
  }
}

export const addSkillSchema = {
  body: {
    type: 'object',
    required: ['name', 'actionId'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 255 },
      description: { type: 'string', maxLength: 1000 },
      actionId: { type: 'string', minLength: 1, maxLength: 100 },
      config: { type: 'object' }
    }
  }
}

export const updateSettingsSchema = {
  body: {
    type: 'object',
    properties: {
      llmConfig: { type: 'object' },
      features: { type: 'object' }
    }
  }
}
