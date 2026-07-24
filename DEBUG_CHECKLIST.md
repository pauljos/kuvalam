# Debug Checklist for Agent UI Issues

## Quick Diagnostic Steps

### 1. Check Browser Console for Errors

Open DevTools (F12) and look for:
```
- CORS errors
- 401 Unauthorized errors
- Network timeout errors
- JavaScript exceptions
```

### 2. Test Each Button Individually

#### Testing Skills Delete Button:

1. Navigate to an agent detail page with skills
2. Open DevTools Console (F12)
3. Click the delete (🗑) button on a skill
4. Expected behavior:
   - Confirmation modal appears
   - Click "Remove" button
   - Network request to: `DELETE /api/v1/tenants/{tenantId}/agents/{agentId}/skills/{skillId}`
   - Skill disappears from the list
   - Toast notification: "Skill removed"

**If not working, check:**
- Is the confirmation modal appearing?
- What happens after clicking "Remove"?
- Any error in Console?
- Check Network tab for the DELETE request

#### Testing Agent Stop Button:

1. Start an agent task execution
2. While it's running, click the red "Cancel" button
3. Expected behavior:
   - Task execution stops immediately
   - Network request to: `POST /api/v1/tenants/{tenantId}/agents/{agentId}/tasks/{taskId}/cancel`
   - Status changes to "CANCELLED"
   - Toast notification: "Task Cancelled"

**If not working, check:**
- Is the Cancel button visible during execution?
- Any error in Console when clicking?
- Check Network tab for the POST request
- Look at WebSocket messages (if any)

#### Testing Past Task Stop Button:

1. Find a task in "Past Executions" with status "RUNNING" or "PENDING"
2. Click the yellow "STOP" button (top-right of the task card)
3. Expected behavior:
   - Confirmation modal: "Stop Execution"
   - Click "Stop"
   - Network request to: `POST /api/v1/tenants/{tenantId}/agents/{agentId}/tasks/{taskId}/cancel`
   - Task status changes to "CANCELLED"
   - Toast notification: "Execution stopped"

---

## Common Issues & Solutions

### Issue: Confirmation Modal Not Appearing

**Possible causes:**
1. CSS z-index conflict
2. Modal portal not rendering
3. JavaScript error preventing render

**Solution:**
Check if `{ConfirmDialog}` is rendered at the end of the component (line 888 in agent detail page)

---

### Issue: API Request Fails with 401

**Possible causes:**
1. JWT token expired
2. Cookie not being sent
3. CORS issue

**Solution:**
```javascript
// Check localStorage
console.log('Token:', localStorage.getItem('kuvalam_access_token'))
console.log('Tenant:', localStorage.getItem('kuvalam_tenant_id'))

// Check if auto-refresh is working
// The api.ts file should automatically refresh on 401
```

---

### Issue: Button Click Does Nothing

**Possible causes:**
1. Event handler not bound
2. JavaScript error before handler executes
3. `e.stopPropagation()` preventing event

**Debug steps:**
```javascript
// Add console.log to handlers
async function handleRemoveSkill(e: any, skillId: string) {
  console.log('DELETE SKILL CLICKED', skillId)
  e.stopPropagation()
  const ok = await confirm({
    title: 'Remove Skill',
    description: 'Are you sure you want to remove this skill?',
    confirmLabel: 'Remove'
  })
  console.log('USER CONFIRMED?', ok)
  if (!ok) return
  // ... rest of code
}
```

---

### Issue: Ollama Models Not Showing

**This is expected behavior!** 

The UI shows:
1. **Custom fine-tuned models** (from Custom Models page) → Dropdown
2. **Base Ollama models** → Text input with autocomplete

To see your Ollama models, you need to:
1. Type the model name manually (e.g., `llama3.2`, `mistral`)
2. Or train a custom model via the Custom Models page

**To add Ollama model dropdown:**

You would need to implement:
1. API endpoint to fetch Ollama models
2. Update frontend to call this endpoint
3. Display models in dropdown

See the full implementation suggestion in BUG_FIXES.md

---

## Testing Script

Run this in the browser console while on the agent detail page:

```javascript
// Test if handlers are defined
console.log('handleRemoveSkill:', typeof handleRemoveSkill)
console.log('cancelTask:', typeof cancelTask)
console.log('handleCancelTask:', typeof handleCancelTask)

// Test API client
console.log('api.removeSkill:', typeof api.removeSkill)
console.log('api.cancelTask:', typeof api.cancelTask)

// Test confirmation dialog
console.log('confirm function:', typeof confirm)

// Check current state
console.log('Agent:', agent)
console.log('Task:', task)
console.log('Running:', running)
console.log('Past tasks:', pastTasks)
```

---

## Network Tab Inspection

### For Delete Skill:

```
Request URL: http://localhost:3001/api/v1/tenants/{uuid}/agents/{uuid}/skills/{uuid}
Request Method: DELETE
Status Code: 200 OK (expected)
Response: {"success":true,"meta":{"timestamp":"..."}}
```

### For Cancel Task:

```
Request URL: http://localhost:3001/api/v1/tenants/{uuid}/agents/{uuid}/tasks/{uuid}/cancel
Request Method: POST
Status Code: 200 OK (expected)
Response: {"success":true,"meta":{"timestamp":"..."}}
```

---

## Backend Verification

### Check if backend routes are registered:

```bash
# In apps/api directory
cd apps/api
npm run dev

# Look for these lines in startup logs:
# DELETE /tenants/:tenantId/agents/:agentId/skills/:skillId
# POST /tenants/:tenantId/agents/:agentId/tasks/:taskId/cancel
```

### Test API directly with curl:

```bash
# Get your token from localStorage
TOKEN="your-jwt-token-here"
TENANT_ID="your-tenant-id"
AGENT_ID="your-agent-id"
SKILL_ID="skill-to-delete"

# Test delete skill
curl -X DELETE \
  "http://localhost:3001/api/v1/tenants/$TENANT_ID/agents/$AGENT_ID/skills/$SKILL_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"

# Test cancel task
TASK_ID="running-task-id"
curl -X POST \
  "http://localhost:3001/api/v1/tenants/$TENANT_ID/agents/$AGENT_ID/tasks/$TASK_ID/cancel" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"
```

---

## If Everything Checks Out But Still Not Working

### Possible React State Issues:

The buttons depend on state variables:
- `agent` state for skills
- `task` and `running` state for current execution
- `pastTasks` state for past executions

**Verify state is updating:**
```javascript
// Add this to useEffect
useEffect(() => {
  console.log('Agent state changed:', agent)
}, [agent])

useEffect(() => {
  console.log('Task state changed:', task)
}, [task])

useEffect(() => {
  console.log('Past tasks changed:', pastTasks)
}, [pastTasks])
```

---

## Quick Fix: Force Reload After Operations

If the UI isn't updating but the API calls succeed, add a page reload:

```typescript
// In handleRemoveSkill
await api.removeSkill(tenantId, agentId, skillId)
toast('success', 'Skill removed')
window.location.reload() // Force reload

// In cancelTask
await api.cancelTask(tenantId, agentId, task?.id || currentTaskId.current)
toast('success', 'Execution stopped')
window.location.reload() // Force reload
```

This isn't elegant but will confirm if it's a state management issue.

---

## Next Steps

1. Follow the diagnostic steps above
2. Share the specific error messages or behavior you see
3. Check the Network tab for failed requests
4. Look for console errors

If you can provide:
- Browser console errors
- Network tab screenshots
- Specific steps to reproduce

I can provide a more targeted fix!
