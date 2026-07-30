// ═══════════════════════════════════════════════════════════════════════════════
// RBAC Middleware — Role-Based Access Control
// ═══════════════════════════════════════════════════════════════════════════════

import { AppError } from '../utils/errors.js'

/**
 * Require specific roles for a route
 * @param {string[]} allowedRoles - Array of allowed roles (e.g., ['OWNER', 'ADMIN'])
 * @returns {Function} Fastify preHandler hook
 */
export function requireRole(allowedRoles) {
  return async (request, reply) => {
    const userRole = request.user?.role
    
    if (!userRole) {
      throw new AppError('UNAUTHORIZED', 'Authentication required', 401)
    }
    
    if (!allowedRoles.includes(userRole)) {
      throw new AppError('FORBIDDEN', `This action requires one of: ${allowedRoles.join(', ')}`, 403)
    }
  }
}

/**
 * Require OWNER role only
 */
export const requireOwner = requireRole(['OWNER'])

/**
 * Require OWNER or ADMIN role
 */
export const requireAdmin = requireRole(['OWNER', 'ADMIN'])

/**
 * Require any authenticated user (OWNER, ADMIN, MEMBER, VIEWER)
 */
export const requireAuth = requireRole(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'])

/**
 * Permission-based access control
 * Maps permissions to required roles
 */
const PERMISSIONS = {
  // Connector permissions
  'connector:create': ['OWNER', 'ADMIN'],
  'connector:update': ['OWNER', 'ADMIN'],
  'connector:delete': ['OWNER', 'ADMIN'],
  'connector:read': ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
  
  // MCP permissions
  'mcp:create': ['OWNER', 'ADMIN'],
  'mcp:update': ['OWNER', 'ADMIN'],
  'mcp:delete': ['OWNER', 'ADMIN'],
  'mcp:read': ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
  
  // Workflow permissions
  'workflow:create': ['OWNER', 'ADMIN', 'MEMBER'],
  'workflow:update': ['OWNER', 'ADMIN', 'MEMBER'],
  'workflow:delete': ['OWNER', 'ADMIN'],
  'workflow:execute': ['OWNER', 'ADMIN', 'MEMBER'],
  'workflow:read': ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
  
  // Agent permissions
  'agent:create': ['OWNER', 'ADMIN', 'MEMBER'],
  'agent:update': ['OWNER', 'ADMIN', 'MEMBER'],
  'agent:delete': ['OWNER', 'ADMIN'],
  'agent:execute': ['OWNER', 'ADMIN', 'MEMBER'],
  'agent:read':   ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
  'agent:scopes': ['OWNER', 'ADMIN'],   // tool scope control — admin only

  // Settings permissions
  'settings:update': ['OWNER', 'ADMIN'],
  'settings:read': ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
  
  // Member permissions
  'member:invite': ['OWNER', 'ADMIN'],
  'member:remove': ['OWNER', 'ADMIN'],
  'member:update_role': ['OWNER'],
  'member:read': ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
  
  // Knowledge base permissions
  'kb:create': ['OWNER', 'ADMIN', 'MEMBER'],
  'kb:update': ['OWNER', 'ADMIN', 'MEMBER'],
  'kb:delete': ['OWNER', 'ADMIN'],
  'kb:read': ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
  
  // Skill test permissions (dangerous - code execution)
  'skill:test': ['OWNER', 'ADMIN'],
}

/**
 * Require specific permission
 * @param {string} permission - Permission key (e.g., 'connector:create')
 * @returns {Function} Fastify preHandler hook
 */
export function requirePermission(permission) {
  const allowedRoles = PERMISSIONS[permission]
  
  if (!allowedRoles) {
    throw new Error(`Unknown permission: ${permission}`)
  }
  
  return requireRole(allowedRoles)
}
