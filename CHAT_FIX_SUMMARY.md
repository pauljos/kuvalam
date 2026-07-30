# Chat Feature - Model Selection Fix

## Issue Identified
The chat page was not allowing users to select which model/provider to use for conversations. It was automatically using the default configured model without any UI to change it.

## Changes Made

### Enhanced Chat Page (`apps/web/src/app/dashboard/chat/page.tsx`)

**Added:**
1. **Model Selection Modal** - Appears when clicking "New Chat"
2. **Provider Selection Dropdown** - Shows all configured LLM providers
3. **Model Input Field** - Allows specifying/editing the model name
4. **State Management** - Added states for modal and selection:
   - `showNewChatModal` - Controls modal visibility
   - `selectedProvider` - Currently selected provider
   - `selectedModel` - Currently selected model

**Features:**
- Shows default provider in dropdown
- Auto-fills model when provider is selected
- Displays current configured model for reference
- Validates selection before creating conversation
- Modal can be dismissed by clicking outside or Cancel

## How to Use

1. **Open Chat Page**: Navigate to http://localhost:3000/dashboard/chat

2. **Create New Chat**:
   - Click "New Chat" button
   - Modal appears with model selection

3. **Select Provider**:
   - Choose from configured providers (OpenAI, Anthropic, Ollama, etc.)
   - Default provider is pre-selected

4. **Choose/Edit Model**:
   - Model auto-fills from provider config
   - Can edit to use a different model from that provider
   - Examples: `gpt-4o`, `claude-3-5-sonnet`, `llama3.2`

5. **Create Chat**:
   - Click "Create Chat"
   - Conversation is created with selected model
   - Start chatting immediately

## Model Selection Per Conversation

Each conversation is locked to its selected model. This is by design because:
- Maintains conversation context consistency
- Prevents confusion from model switching mid-conversation
- Each model has different capabilities and response styles

**To test a different model:** Create a new conversation with the desired model.

## Testing Custom Models

After training a custom model in Settings → Custom Models:

1. Activate the custom model (makes it the default)
2. Create new chat conversation
3. The custom model will appear in the provider list
4. Select it and test responses
5. Verify it has learned from your training data

## Current Status

✅ **FIXED**
- Model selection modal implemented
- Provider dropdown working
- Model input editable
- Validation in place
- Conversations use selected model

## Next Steps for Users

1. Configure at least one LLM provider in Settings
2. Go to Chat page
3. Click "New Chat"
4. Select provider and model
5. Start testing!

## Example Providers

**Cloud Providers:**
- OpenAI: `gpt-4o`, `gpt-4o-mini`
- Anthropic: `claude-3-5-sonnet-20241022`
- OpenRouter: `openai/gpt-4o`, `anthropic/claude-3.5-sonnet`

**Local Providers:**
- Ollama: `llama3.2`, `qwen2.5-coder`, `deepseek-r1`
- LM Studio: `local-model`
- Custom: Your trained model name

## Troubleshooting

**"No LLM configured" error:**
- Go to Settings → LLM Providers
- Configure at least one provider
- Test connection
- Return to Chat

**Model not responding:**
- Check provider is configured correctly
- Verify API key for cloud providers
- Ensure local models are running (Ollama/LM Studio)
- Check API server logs for errors

**Can't see custom model:**
- Verify model was trained successfully in Settings → Custom Models
- Check model status is "COMPLETED"
- Activate the model to make it default
- It will appear as a provider option
