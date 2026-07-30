# Chat with LLM Feature

A chat interface for testing and interacting with configured language models, including custom fine-tuned models.

## Features

- **Multiple Conversations**: Create and manage multiple chat sessions
- **Any LLM Provider**: Works with any configured provider (OpenAI, Anthropic, Ollama, custom models, etc.)
- **Message History**: Full conversation history with timestamps
- **Real-time Responses**: Get responses from your configured LLMs
- **Custom Model Testing**: Perfect for testing custom fine-tuned models before deploying to agents

## Usage

### Via Web Interface

1. Navigate to **Dashboard → Chat** in the sidebar
2. Click **"New Chat"** to start a conversation
3. Select which model/provider to use (defaults to your tenant's default LLM)
4. Start chatting!

Each conversation maintains its own context and history.

### Via API

#### Create a Conversation
```bash
POST /api/v1/tenants/:tenantId/chat/conversations
{
  "title": "My Chat Session",
  "model": "gpt-4o",
  "provider": "openai"
}
```

#### Send a Message
```bash
POST /api/v1/tenants/:tenantId/chat/conversations/:conversationId/messages
{
  "content": "Hello, how are you?"
}
```

#### Get Messages
```bash
GET /api/v1/tenants/:tenantId/chat/conversations/:conversationId/messages
```

#### List Conversations
```bash
GET /api/v1/tenants/:tenantId/chat/conversations
```

#### Delete a Conversation
```bash
DELETE /api/v1/tenants/:tenantId/chat/conversations/:conversationId
```

## Testing Custom Models

After training a custom model:

1. Go to **Settings → Custom Models**
2. Train or activate a custom model
3. Once activated, it becomes your default provider
4. Open **Chat** to test the custom model
5. Create conversations and verify responses match your training data

## Database Schema

### chat_conversations
- `id` - Conversation UUID
- `tenant_id` - Organization ID
- `user_id` - User who created the conversation
- `title` - Conversation title
- `model` - LLM model name
- `provider` - LLM provider (openai, anthropic, ollama, etc.)
- `created_at` - Creation timestamp
- `updated_at` - Last message timestamp

### chat_messages
- `id` - Message UUID
- `conversation_id` - Parent conversation
- `role` - 'user', 'assistant', or 'system'
- `content` - Message text
- `model` - Model that generated this message
- `prompt_tokens` - Input tokens used
- `completion_tokens` - Output tokens used
- `created_at` - Message timestamp

## Testing

Run the test script to verify everything works:

```bash
node test_chat.mjs
```

This will:
1. Log in as admin
2. Check LLM configuration
3. Create a test conversation
4. Send a message and verify response
5. List all conversations

## Architecture

```
Web UI (React)
    ↓
API Routes (Fastify)
    ↓
Chat Service
    ↓
LLM Service → Configured Provider
    ↓
Response saved to DB
```

The chat service uses the same `llm.service.js` that agents use, ensuring consistency between chat responses and agent behavior.

## Use Cases

1. **Test Custom Models**: Verify fine-tuned models work correctly before assigning to agents
2. **Compare Providers**: Chat with different providers to compare response quality
3. **Debug Prompts**: Test prompt variations before adding to agents
4. **Training Data Validation**: Ensure custom models learned from your training data
5. **Quick LLM Access**: Get answers from your LLMs without creating agents

## Notes

- Conversations are user-scoped (each user sees only their own chats)
- Messages are stored in the database for full history
- Token usage is tracked for cost monitoring
- The selected model/provider is locked per conversation (can't change mid-chat)
- To test a different model, create a new conversation
