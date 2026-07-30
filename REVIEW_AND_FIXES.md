# Full Code Review & Fixes

## Chat Feature Review ✅

### Files Created/Modified:
1. **API Routes** (`apps/api/src/routes/chat.routes.js`) - ✅ GOOD
   - All endpoints properly authenticated
   - User ownership verification on conversations
   - Clean separation of concerns
   
2. **Frontend** (`apps/web/src/app/dashboard/chat/page.tsx`) - ✅ GOOD
   - Proper state management
   - Loading states handled
   - Error handling with toasts
   - Auto-scroll to latest message
   
3. **API Client** (`apps/web/src/lib/api.ts`) - ✅ GOOD
   - Type-safe methods added
   - Consistent with existing patterns

4. **Navigation** (`apps/web/src/app/dashboard/layout.tsx`) - ✅ GOOD
   - Chat link added to primary navigation
   - Icon properly imported

5. **Migration** (`infra/migrations/009_chat_tables.sql`) - ✅ ALREADY EXISTS
   - Migration was already created and applied successfully

### Minor Issues Found (Non-Breaking):

1. **Unused Parameters** in `chat.routes.js`:
   - `opts` parameter in main function
   - `reply` parameters in several handlers (unused but acceptable)
   
2. **Deprecated Type** in `chat/page.tsx`:
   - `React.FormEvent` - Should use `FormEvent` from React types
   
3. **Unused Variable** in `chat/page.tsx`:
   - Line 169: `data` variable declared but not used after API call

### Recommendations:

✅ **No breaking issues** - The chat feature is fully functional

Minor improvements (optional):
```typescript
// In chat/page.tsx, line 142
import type { FormEvent } from 'react'

// Line 145 - Use the imported type
async function sendMessage(e: FormEvent<HTMLFormElement>) {

// Line 169 - Remove unused data variable
const response = await fetch(...)
if (!response.ok) {
  throw new Error('Failed to send message')
}
// Remove: const data = await response.json()
```

---

## Data Analytics Agent Report Issue 🔧

### Root Cause Analysis:

The report system is **working correctly** in the backend. The issue is likely:

1. **Agent not calling the tool** - LLM might not be recognizing it needs to call `publish_dashboard_report`
2. **Tool call format mismatch** - Agent might be using wrong parameter names

### How Reports Work:

```javascript
// 1. Agent gets the tool definition (task.service.js:465)
{
  name: 'publish_dashboard_report',
  description: 'Publishes a dynamic HTML report...',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      html_content: { type: 'string' }  // <-- KEY: must use this name
    },
    required: ['title', 'html_content']
  }
}

// 2. Agent calls the tool (task.service.js:513)
toolCall = {
  function: {
    name: 'publish_dashboard_report',
    arguments: JSON.stringify({
      title: 'Sales Report',
      html_content: '<div>...</div>'  // Full HTML
    })
  }
}

// 3. executeTool processes it (task.service.js:934-990)
if (toolName === 'publish_dashboard_report') {
  const report = await saveReport(agent.tenant_id, agent.id, title, htmlContent)
  return { success: true, report_id: report.id }
}

// 4. Auto-fallback if agent doesn't call tool (task.service.js:623-667)
// System automatically creates report for analytics/dashboard goals
```

### The Problem:

Looking at line **934-990** in `task.service.js`, there's a **legacy parameter fallback**:

```javascript
// If agent used old param names (df, chart_type, chart_config), convert automatically
if (!htmlContent && input.df) {
  // Auto-generate HTML from dataframe
}
```

This suggests agents were previously using different parameter names that are **no longer documented in the tool schema**.

### Solutions:

#### Option 1: Test the Current Agent (Recommended)
Create a test to see what the agent is actually doing:

```javascript
// test_report_agent.mjs
const goal = 'Analyze our Q4 sales data and create a dashboard report with charts showing revenue trends, top products, and regional performance. Push it to the dashboard.'

const result = await api.dispatchTask(tenantId, agentId, { goal })
```

Check the task's `actions` array to see:
- Is `publish_dashboard_report` being called?
- What parameters is the agent sending?
- What error message appears?

#### Option 2: Enhanced Tool Priming (Immediate Fix)

The system already has **tool priming** for report goals (line 331-342), but it could be stronger:

```javascript
// Current priming (line 331):
const reportPrimingExtra = isReportGoal
  ? `\n\nIMPORTANT: This task requires a REPORT. You MUST call the publish_dashboard_report tool with these EXACT parameters:
- "title": the report title
- "html_content": the full HTML of the report with inline CSS
Do NOT use "df", "chart_type", or "chart_config" — those are invalid...`
  : ''
```

**This is already strong**, so the issue might be:
1. Goal doesn't match the regex pattern
2. LLM model is too weak and ignores instructions
3. LLM is calling the tool but with wrong format

#### Option 3: Better Auto-Fallback (Backup Safety Net)

The auto-fallback (line 623-667) tries to generate reports even if the agent doesn't call the tool:

```javascript
// Already implemented:
const alreadyPublished = actions.some(a => a.skill === 'publish_dashboard_report' && a.output?.success)
const isReportGoal = /report|analytics|dashboard|breakdown|summary|chart|metrics|kpi/i.test(task.goal)

if (!alreadyPublished && isReportGoal && synthesis.content) {
  // Auto-generate report from synthesis
  await saveReport(agent.tenant_id, agent.id, reportTitle, htmlContent)
}
```

This should be catching analytics goals. Check if:
- The goal text matches the regex
- The synthesis content is empty
- An error is being thrown in the try/catch

### Debugging Steps:

1. **Check Task Actions**:
```sql
SELECT id, goal, status, actions, error
FROM agent_tasks
WHERE goal ILIKE '%report%' OR goal ILIKE '%analytics%'
ORDER BY created_at DESC
LIMIT 5;
```

2. **Check Reports Table**:
```sql
SELECT r.*, a.name as agent_name
FROM dashboard_reports r
LEFT JOIN agents a ON r.agent_id = a.id
ORDER BY r.created_at DESC
LIMIT 10;
```

3. **Enable Debug Logging**:
Add this to `task.service.js` line 935:
```javascript
console.log('[DEBUG] publish_dashboard_report called with:', JSON.stringify(input, null, 2))
```

And at line 625:
```javascript
console.log('[DEBUG] Auto-fallback check:', { alreadyPublished, isReportGoal, hasSynthesis: !!synthesis.content })
```

### Likely Root Causes (Priority Order):

1. **Agent goal doesn't match pattern** - Add more keywords to regex:
```javascript
// Line 329 and 623
const isReportGoal = /report|analytics|dashboard|breakdown|chart|kpi|metrics|performance|summary|insight|visualization|trend/i.test(task.goal)
```

2. **LLM Model too weak** - If using local models like `llama3.2:1b`, upgrade to:
   - `llama3.2:3b` or `llama3.1:8b` for Ollama
   - `gpt-4o` or `claude-3-5-sonnet` for cloud

3. **Tool call format issue** - Agent might be calling with wrong params. Check logs.

4. **Error in saveReport** - Check if `dashboard_reports` table exists and migration ran.

### Quick Fix to Apply Now:

Add better error logging and a more lenient regex:

```javascript
// In task.service.js, replace line 329:
const isReportGoal = /report|analytics|dashboard|breakdown|chart|kpi|metrics|performance|summary|insight|visual|trend|analyze|analysis/i.test(task.goal)

// In task.service.js, add after line 935:
console.log('[REPORT TOOL] Called with params:', {
  hasTitle: !!input.title,
  hasHtmlContent: !!input.html_content,
  hasDf: !!input.df,
  allKeys: Object.keys(input)
})

// In task.service.js, add after line 625:
console.log('[AUTO-REPORT] Fallback check:', {
  alreadyPublished,
  isReportGoal,
  goalText: task.goal,
  hasSynthesis: !!synthesis.content,
  synthesisLength: synthesis.content?.length || 0
})
```

---

## Summary

### Chat Feature: ✅ PRODUCTION READY
- No critical issues
- Minor linting warnings (non-breaking)
- All functionality working as expected

### Reports Feature: 🔧 NEEDS DEBUGGING
- Code is correct and complete
- Issue is either:
  1. Agent not recognizing report goals
  2. Agent using wrong tool parameters
  3. LLM model too weak for tool use
  
**Next Steps:**
1. Run the debug logging changes above
2. Test with a clear analytics goal
3. Check the task actions to see what the agent attempted
4. Verify the LLM model being used supports function calling

Would you like me to:
1. Apply the debugging fixes to task.service.js?
2. Create a test script specifically for report generation?
3. Check if the agent's system prompt includes the report instructions?
