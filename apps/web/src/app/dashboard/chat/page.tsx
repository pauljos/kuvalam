'use client'
import { useEffect, useState, useRef } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'
import { MessageSquare, Send, Trash2, Plus, Database, GitFork, Paperclip, X, Mic, MicOff } from 'lucide-react'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
}

interface Conversation {
  id: string
  title: string
  model: string
  provider: string
  created_at: string
  last_message_preview?: string
}

interface KnowledgeBase {
  id: string
  name: string
  document_count: number
}

interface KnowledgeGraph {
  id: string
  name: string
  entity_count: number
  relationship_count: number
}

function renderMarkdown(text: string): string {
  // Escape HTML first so no raw tags survive the transform.
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;')
     .replace(/</g, '&lt;')
     .replace(/>/g, '&gt;')
     .replace(/"/g, '&quot;')
     .replace(/'/g, '&#39;')

  // Only allow http(s) and mailto URIs — blocks javascript:, data:, vbscript:, etc.
  const safeUrl = (u: string) => {
    const trimmed = u.trim()
    if (/^(https?:|mailto:)/i.test(trimmed)) return esc(trimmed)
    return '#'
  }

  // Extract fenced code blocks first (so their contents are not further transformed).
  const codeBlocks: string[] = []
  let out = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, body) => {
    const idx = codeBlocks.push(
      `<pre style="background:#1a1a2e;color:#e4e4e4;padding:10px;border-radius:6px;overflow-x:auto;font-size:12px;font-family:monospace"><code>${esc(body)}</code></pre>`
    ) - 1
    return `\u0000CODEBLOCK${idx}\u0000`
  })

  // Escape the remaining text.
  out = esc(out)

  // Inline code (already HTML-escaped above; safe to run on esc'd content).
  out = out.replace(/`([^`]+)`/g, (_m, code) =>
    `<code style="background:#f3f4f6;padding:1px 5px;border-radius:3px;font-size:12px;font-family:monospace;color:#dc2626">${code}</code>`
  )

  // Emphasis — patterns operate on already-escaped text.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>')

  // Images: sanitize URL, alt is already esc'd.
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) =>
    `<img alt="${alt}" src="${safeUrl(url)}" style="max-width:100%;border-radius:6px;margin:8px 0" />`
  )

  // Links: sanitize URL scheme; label is already esc'd.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) =>
    `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer" style="color:#3b82f6;text-decoration:underline">${label}</a>`
  )

  out = out.replace(/\n/g, '<br />')

  // Restore code blocks.
  out = out.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_m, i) => codeBlocks[Number(i)])
  return out
}

export default function ChatPage() {
  const { tenantId, toast } = useApp()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [llmConfig, setLlmConfig] = useState<any>(null)
  const [showNewChatModal, setShowNewChatModal] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<string>('')
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [newChatTitle, setNewChatTitle] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [editTitleValue, setEditTitleValue] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [selectedKnowledgeBaseIds, setSelectedKnowledgeBaseIds] = useState<string[]>([])
  const [showKBSelector, setShowKBSelector] = useState(false)
  const kbDropdownRef = useRef<HTMLDivElement>(null)
  const [knowledgeGraphs, setKnowledgeGraphs] = useState<KnowledgeGraph[]>([])
  const [selectedGraphIds, setSelectedGraphIds] = useState<string[]>([])
  const [showGraphSelector, setShowGraphSelector] = useState(false)
  const graphDropdownRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const commandMenuRef = useRef<HTMLDivElement>(null)
  const recognitionRef = useRef<any>(null)
  const [attachments, setAttachments] = useState<{name: string, type: string, contentBase64: string}[]>([])
  const [thinkingLevel, setThinkingLevel] = useState<'off'|'low'|'medium'|'high'>('off')
  const [listening, setListening] = useState(false)
  const [showCommandMenu, setShowCommandMenu] = useState(false)

  const SLASH_COMMANDS = [
    { cmd: '/new', args: '[title]', desc: 'Start a new conversation' },
    { cmd: '/reset', args: '', desc: 'Clear all messages in this conversation' },
    { cmd: '/think', args: '[off|low|medium|high]', desc: 'Set LLM reasoning depth' },
    { cmd: '/compact', args: '', desc: 'Summarize & compact this conversation' },
    { cmd: '/help', args: '', desc: 'Show available commands' },
  ]

  // Close KB/graph dropdowns on outside click
  useEffect(() => {
    if (!showKBSelector && !showGraphSelector) return
    function handleClickOutside(e: MouseEvent) {
      if (kbDropdownRef.current && !kbDropdownRef.current.contains(e.target as Node)) {
        setShowKBSelector(false)
      }
      if (graphDropdownRef.current && !graphDropdownRef.current.contains(e.target as Node)) {
        setShowGraphSelector(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showKBSelector, showGraphSelector])

  useEffect(() => {
    if (tenantId) {
      loadConversations()
      loadSettings()
      loadKnowledgeBases()
      loadGraphs()
    }
  }, [tenantId])

  useEffect(() => {
    if (activeConversation) {
      loadMessages(activeConversation.id)
    }
  }, [activeConversation])

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  async function loadSettings() {
    try {
      const settings = await api.getSettings(tenantId)
      setLlmConfig(settings.llm_config)
    } catch (err: any) {
      console.error('Failed to load settings:', err)
      toast('error', 'Failed to load settings', (err as any)?.message || '')
    }
  }

  async function loadKnowledgeBases() {
    try {
      const data = await api.listKBs(tenantId)
      setKnowledgeBases(data.knowledgeBases || data || [])
    } catch (err: any) {
      console.error('Failed to load knowledge bases:', err)
    }
  }

  function toggleKnowledgeBase(kbId: string) {
    setSelectedKnowledgeBaseIds(prev =>
      prev.includes(kbId)
        ? prev.filter(id => id !== kbId)
        : [...prev, kbId]
    )
    setShowKBSelector(false)
  }

  async function loadGraphs() {
    try {
      const data = await api.listKnowledgeGraphs(tenantId)
      setKnowledgeGraphs(data.knowledgeGraphs || data || [])
    } catch (err: any) {
      console.error('Failed to load graphs:', err)
    }
  }

  function toggleGraph(graphId: string) {
    setSelectedGraphIds(prev =>
      prev.includes(graphId)
        ? prev.filter(id => id !== graphId)
        : [...prev, graphId]
    )
    setShowGraphSelector(false)
  }

  async function loadConversations() {
    try {
      const data = await api.listChatConversations(tenantId)
      setConversations(data.conversations || [])
    } catch (err: any) {
      toast('error', 'Failed to load conversations', err.message)
    }
  }

  async function loadMessages(conversationId: string) {
    try {
      setLoading(true)
      const data = await api.getChatMessages(tenantId, conversationId)
      setMessages(data.messages || [])
    } catch (err: any) {
      toast('error', 'Failed to load messages', err.message)
    } finally {
      setLoading(false)
    }
  }

  // Fetch available models when provider changes (especially for local providers)
  async function fetchAvailableModels(provider: string) {
    const providerConfig = llmConfig?.providers?.[provider]
    
    // For Ollama, use the dedicated endpoint
    if (provider === 'ollama') {
      setLoadingModels(true)
      try {
        const result = await api.getOllamaAvailableModels(tenantId)
        
        // Handle both array of objects and array of strings
        let models: string[] = []
        if (result.models && Array.isArray(result.models)) {
          models = result.models.map((m: any) => 
            typeof m === 'string' ? m : m.name
          )
        }
        
        if (models.length > 0) {
          setAvailableModels(models)
          // Auto-select configured model if it exists, otherwise first model
          const configuredModel = providerConfig?.model
          if (configuredModel && models.includes(configuredModel)) {
            setSelectedModel(configuredModel)
          } else if (!selectedModel || !models.includes(selectedModel)) {
            setSelectedModel(models[0])
          }
        } else {
          // No models found - Ollama might not be running
          setAvailableModels(getCommonModels(provider))
        }
      } catch (err) {
        console.error('Failed to fetch Ollama models:', err)
        toast('error', 'Failed to fetch Ollama models', (err as any)?.message || '')
        setAvailableModels(getCommonModels(provider))
      } finally {
        setLoadingModels(false)
      }
      return
    }
    
    // For other local providers, try the test endpoint
    const isLocal = ['lmstudio', 'localai', 'custom'].includes(provider)
    
    if (isLocal) {
      setLoadingModels(true)
      try {
        const baseUrl = providerConfig?.baseUrl
        if (!baseUrl) {
          setAvailableModels(getCommonModels(provider))
          setLoadingModels(false)
          return
        }

        const result = await api.testLLMProvider(tenantId, { 
          provider, 
          baseUrl,
          model: providerConfig?.model || 'test'
        })
        
        if (result.models?.length > 0) {
          setAvailableModels(result.models)
          if (!result.models.includes(selectedModel)) {
            setSelectedModel(result.models[0])
          }
        } else {
          setAvailableModels(getCommonModels(provider))
        }
      } catch (err) {
        console.error('Failed to fetch models:', err)
        toast('error', 'Failed to fetch models', (err as any)?.message || '')
        setAvailableModels(getCommonModels(provider))
      } finally {
        setLoadingModels(false)
      }
      return
    }
    
    // For cloud providers, use the hardcoded list
    setAvailableModels(getCommonModels(provider))
  }

  // Get common/default models for a provider
  function getCommonModels(provider: string): string[] {
    const commonModels: Record<string, string[]> = {
      openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
      anthropic: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
      openrouter: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet', 'google/gemini-pro-1.5', 'meta-llama/llama-3.1-70b-instruct'],
      opencode: ['deepseek-v4-pro', 'minimax-m3', 'qwen3.7-max', 'mimo-v2-pro'],
      deepseek: ['deepseek-chat', 'deepseek-reasoner'],
      kimi: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'moonshot-v1-auto'],
      groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
      mistral: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
      ollama: ['llama3.2', 'llama3.1', 'qwen2.5-coder', 'deepseek-r1', 'mistral', 'gemma2'],
      lmstudio: ['local-model'],
      localai: ['gpt-3.5-turbo', 'ggml-gpt4all-j'],
      custom: []
    }

    const models = commonModels[provider] || []
    const configuredModel = llmConfig?.providers?.[provider]?.model
    
    // Add configured model if not in list
    if (configuredModel && !models.includes(configuredModel)) {
      return [configuredModel, ...models]
    }
    
    return models
  }

  // Get available models for a provider (common models + configured model)
  function getAvailableModels(provider: string): string[] {
    // If we have dynamically fetched models, use those
    if (availableModels.length > 0) {
      return availableModels
    }
    // Otherwise fall back to common models
    return getCommonModels(provider)
  }

  function openNewChatModal() {
    if (!llmConfig?.providers || Object.keys(llmConfig.providers).length === 0) {
      toast('error', 'No LLM configured', 'Please configure an LLM provider in Settings first.')
      return
    }

    const defaultProvider = llmConfig.defaultProvider || Object.keys(llmConfig.providers)[0]
    const defaultModel = llmConfig.providers[defaultProvider]?.model

    setSelectedProvider(defaultProvider)
    setSelectedModel(defaultModel)
    setShowNewChatModal(true)
    
    // Fetch available models for the selected provider
    fetchAvailableModels(defaultProvider)
  }

  async function createNewConversation() {
    if (!selectedProvider || !selectedModel) {
      toast('error', 'Selection required', 'Please select a model')
      return
    }

    try {
      const data = await api.createChatConversation(tenantId, {
        title: newChatTitle.trim() || 'New Chat',
        model: selectedModel,
        provider: selectedProvider
      })
      setConversations([data.conversation, ...conversations])
      setActiveConversation(data.conversation)
      setMessages([])
      setShowNewChatModal(false)
      setNewChatTitle('')
    } catch (err: any) {
      toast('error', 'Failed to create conversation', err.message)
    }
  }

  async function deleteConversation(id: string) {
    try {
      await api.deleteChatConversation(tenantId, id)
      setConversations(conversations.filter(c => c.id !== id))
      if (activeConversation?.id === id) {
        setActiveConversation(null)
        setMessages([])
      }
      toast('success', 'Conversation deleted', '')
    } catch (err: any) {
      toast('error', 'Failed to delete conversation', err.message)
    }
  }

  function addSystemMessage(content: string) {
    const msg: Message = {
      id: Date.now().toString(),
      role: 'system',
      content,
      created_at: new Date().toISOString()
    }
    setMessages(prev => [...prev, msg])
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }

  async function handleSlashCommand(raw: string) {
    const parts = raw.slice(1).split(/\s+/)
    const cmd = '/' + (parts[0] || '').toLowerCase()
    const args = parts.slice(1).join(' ').trim()
    setShowCommandMenu(false)

    switch (cmd) {
      case '/new': {
        if (args) setNewChatTitle(args)
        openNewChatModal()
        break
      }
      case '/reset': {
        if (!activeConversation) { addSystemMessage('No active conversation.'); break }
        if (!confirm('Clear all messages in this conversation?')) break
        try {
          await api.clearChatMessages(tenantId, activeConversation.id)
          setMessages([])
          toast('success', 'Conversation cleared', '')
        } catch (err: any) {
          toast('error', 'Failed to clear', err.message)
        }
        break
      }
      case '/think': {
        const level = args as 'off'|'low'|'medium'|'high'
        if (['off', 'low', 'medium', 'high'].includes(level)) {
          setThinkingLevel(level)
          addSystemMessage(`🧠 Thinking level set to **${level}**${level !== 'off' ? ' — responses will reason more deeply' : ''}`)
        } else {
          addSystemMessage('Usage: `/think [off|low|medium|high]`')
        }
        break
      }
      case '/compact': {
        if (!activeConversation) { addSystemMessage('No active conversation.'); break }
        if (messages.length === 0) { addSystemMessage('Nothing to compact yet.'); break }
        try {
          setStreaming(true)
          const data = await api.summarizeChatConversation(tenantId, activeConversation.id)
          const summary = (data as any)?.data?.summary || (data as any)?.summary || 'Could not summarize.'
          addSystemMessage(`📋 **Conversation Summary:**\n\n${summary}`)
        } catch (err: any) {
          toast('error', 'Failed to compact', err.message)
        } finally {
          setStreaming(false)
        }
        break
      }
      case '/help': {
        addSystemMessage([
          '**Available Commands:**',
          '',
          '`/new [title]` — Start a new conversation',
          '`/reset` — Clear all messages in this conversation',
          '`/think [off|low|medium|high]` — Set LLM reasoning depth',
          '`/compact` — Summarize this conversation',
          '`/help` — Show this help',
        ].join('\n'))
        break
      }
      default: {
        addSystemMessage(`Unknown command: \`${cmd}\`. Type \`/help\` to see available commands.`)
      }
    }
  }

  function startVoice() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) {
      toast('error', 'Voice not supported', 'Try Chrome or Edge for voice input.')
      return
    }
    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }
    const rec = new SR()
    rec.continuous = false
    rec.interimResults = false
    rec.lang = 'en-US'
    rec.onresult = (e: any) => {
      const transcript = Array.from(e.results as any[]).map((r: any) => r[0].transcript).join(' ')
      setInput(prev => prev ? `${prev} ${transcript}` : transcript)
      inputRef.current?.focus()
    }
    rec.onerror = () => setListening(false)
    rec.onend = () => setListening(false)
    recognitionRef.current = rec
    rec.start()
    setListening(true)
  }

  async function handleRename() {
    if (!activeConversation || !editTitleValue.trim()) {
      setEditingTitle(false)
      return
    }
    try {
      const data = await api.updateChatConversation(tenantId, activeConversation.id, { title: editTitleValue.trim() })
      setActiveConversation({ ...activeConversation, title: data.conversation.title })
      setConversations(conversations.map(c => c.id === activeConversation.id ? { ...c, title: data.conversation.title } : c))
    } catch (err: any) {
      toast('error', 'Failed to rename', err.message)
    } finally {
      setEditingTitle(false)
    }
  }

  function startRenaming() {
    setEditTitleValue(activeConversation?.title || '')
    setEditingTitle(true)
    setTimeout(() => titleInputRef.current?.focus(), 50)
  }

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault()
    if (!input.trim() || streaming) return

    // Intercept slash commands
    if (input.trim().startsWith('/')) {
      const cmd = input.trim()
      setInput('')
      setShowCommandMenu(false)
      await handleSlashCommand(cmd)
      return
    }

    if (!activeConversation) return

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      created_at: new Date().toISOString()
    }

    setMessages(prev => [...prev, userMessage])
    const currentInput = input
    setInput('')
    setStreaming(true)

    let assistantMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString()
    }
    setMessages(prev => [...prev, assistantMessage])

    try {
      await api.sendChatMessage(tenantId, activeConversation.id, {
        content: currentInput,
        knowledgeBaseIds: selectedKnowledgeBaseIds.length > 0 ? selectedKnowledgeBaseIds : undefined,
        graphIds: selectedGraphIds.length > 0 ? selectedGraphIds : undefined,
        attachments: attachments.length > 0 ? attachments : undefined
      })

      // Reload messages to get the full conversation including assistant response
      setAttachments([])
      await loadMessages(activeConversation.id)
      await loadConversations()
      
    } catch (err: any) {
      toast('error', 'Failed to send message', err.message)
      // Remove the placeholder assistant message on error
      setMessages(prev => prev.filter(m => m.id !== assistantMessage.id))
    } finally {
      setStreaming(false)
    }
  }

  if (!tenantId) {
    return (
      <div className="page">
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <MessageSquare size={48} style={{ color: 'var(--green)', margin: '0 auto 16px' }} />
          <p style={{ color: 'var(--text-muted)' }}>
            Chat is organization-specific. Please select an organization from the header.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="animate-in" style={{ height: 'calc(100vh - 56px)', display: 'flex', flexDirection: 'column', padding: '0 24px' }}>
      {/* Page header integrated into the flex flow */}
      <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 0 16px' }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 20 }}>Chat</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>Chat with your AI agents or query your LLM directly</p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={openNewChatModal}>
          <Plus size={14} /> New Chat
        </button>
      </div>

      {/* New Chat Modal */}
      {showNewChatModal && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(15, 34, 20, 0.4)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }} onClick={() => setShowNewChatModal(false)}>
          <div className="card" style={{
            width: 440,
            maxWidth: '92%',
            padding: 24,
            boxShadow: '0 20px 60px rgba(0,0,0,0.15)'
          }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>New Chat</h2>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 18 }}>Choose a provider and model for this conversation</p>
            
            <div style={{ marginBottom: 14 }}>
              <label className="form-label">Title (optional)</label>
              <input
                className="input"
                value={newChatTitle}
                style={{ fontSize: 13, padding: '9px 12px' }}
                onChange={(e) => setNewChatTitle(e.target.value)}
                placeholder="e.g. Q2 Report Q&A"
                onKeyDown={(e) => { if (e.key === 'Enter') createNewConversation() }}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label className="form-label">Provider</label>
              <select 
                className="input" 
                value={selectedProvider}
                style={{ fontSize: 13, padding: '9px 12px' }}
                onChange={(e) => {
                  const newProvider = e.target.value
                  setSelectedProvider(newProvider)
                  const model = llmConfig.providers[newProvider]?.model
                  setSelectedModel(model || '')
                  // Fetch available models for new provider
                  fetchAvailableModels(newProvider)
                }}
              >
                {Object.keys(llmConfig?.providers || {}).map(provider => (
                  <option key={provider} value={provider}>
                    {provider} {llmConfig.defaultProvider === provider ? '(default)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom: 0 }}>
              <label className="form-label">
                Model {loadingModels && <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>(Loading...)</span>}
              </label>
              <select 
                className="input" 
                value={selectedModel}
                style={{ fontSize: 13, padding: '9px 12px' }}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={loadingModels}
              >
                <option value="">Select a model...</option>
                {getAvailableModels(selectedProvider).map(model => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
              <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, marginBottom: 8 }}>
                {selectedProvider === 'ollama' 
                  ? availableModels.length > 0 && !loadingModels
                    ? `✓ Found ${availableModels.length} model(s) in your local Ollama`
                    : loadingModels
                    ? 'Checking your local Ollama...'
                    : '⚠ No models found. Is Ollama running?'
                  : selectedProvider === 'lmstudio' || selectedProvider === 'custom'
                  ? 'Select or enter custom model name below'
                  : 'Select from available models for this provider'}
              </p>
              {(selectedProvider === 'ollama' || selectedProvider === 'lmstudio' || selectedProvider === 'custom') && (
                <div style={{ marginTop: 12 }}>
                  <label className="form-label">Or enter a custom model name</label>
                  <input 
                    className="input" 
                    value={selectedModel}
                    style={{ fontSize: 13, padding: '9px 12px' }}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    placeholder="e.g. llama3.2:7b, deepseek-r1:32b"
                  />
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
              <button 
                className="btn btn-secondary" 
                onClick={() => setShowNewChatModal(false)}
              >
                Cancel
              </button>
              <button 
                className="btn btn-primary" 
                onClick={createNewConversation}
                disabled={!selectedProvider || !selectedModel}
              >
                Create Chat
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, gap: 16, overflow: 'hidden', minHeight: 0 }}>
        {/* Conversations sidebar */}
        <div className="card" style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexShrink: 0 }}>
            <h3 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
              💬 Conversations
            </h3>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg)', padding: '2px 8px', borderRadius: 10 }}>{conversations.length}</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {conversations.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '32px 0', textAlign: 'center' }}>
                <MessageSquare size={24} style={{ opacity: 0.3, marginBottom: 8 }} />
                <div>No conversations yet</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>Click "New Chat" to start</div>
              </div>
            ) : (
              conversations.map(conv => (
                <div
                  key={conv.id}
                  onClick={() => setActiveConversation(conv)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: activeConversation?.id === conv.id ? 'var(--green-bg)' : 'transparent',
                    border: `1px solid ${activeConversation?.id === conv.id ? 'var(--green-border)' : 'transparent'}`,
                    cursor: 'pointer',
                    transition: 'all 0.15s'
                  }}
                  onMouseOver={e => { if (activeConversation?.id !== conv.id) { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.borderColor = 'var(--border)'; } }}
                  onMouseOut={e => { if (activeConversation?.id !== conv.id) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; } }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, lineHeight: 1.3 }}>
                      {conv.title}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id) }}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        padding: 3,
                        marginLeft: 6,
                        opacity: 0,
                        flexShrink: 0,
                        borderRadius: 4
                      }}
                      onMouseOver={e => { e.currentTarget.style.opacity = '0.7'; e.currentTarget.style.background = 'var(--bg-hover)'; }}
                      onMouseOut={e => { e.currentTarget.style.opacity = '0'; e.currentTarget.style.background = 'transparent'; }}
                      title="Delete conversation"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {conv.last_message_preview || 'No messages yet'}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, opacity: 0.6 }}>
                    {conv.provider} · {conv.model}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Chat area */}
        <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>
          {!activeConversation ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, padding: 40 }}>
              <div style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--green-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <MessageSquare size={28} style={{ color: 'var(--green)', opacity: 0.5 }} />
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: 14, fontWeight: 500 }}>Select a conversation or create a new one</p>
              <p style={{ color: 'var(--text-muted)', fontSize: 12, opacity: 0.6 }}>Choose from the sidebar or click "New Chat" to get started</p>
            </div>
          ) : (
            <>
              {/* Chat header */}
              <div style={{ flexShrink: 0, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
                <div>
                  {editingTitle ? (
                    <input
                      ref={titleInputRef}
                      className="input"
                      value={editTitleValue}
                      onChange={(e) => setEditTitleValue(e.target.value)}
                      onBlur={handleRename}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setEditingTitle(false) }}
                      style={{ fontSize: 14, fontWeight: 700, padding: '4px 8px', width: '100%', maxWidth: 300 }}
                      maxLength={200}
                    />
                  ) : (
                    <div
                      style={{ fontSize: 14, fontWeight: 700, cursor: 'pointer', padding: '2px 4px', borderRadius: 4 }}
                      onClick={startRenaming}
                      title="Click to rename"
                      onMouseOver={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                      onMouseOut={e => { e.currentTarget.style.background = 'transparent' }}
                    >
                      {activeConversation.title} <span style={{ fontSize: 10, opacity: 0.3, marginLeft: 4 }}>✎</span>
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>{activeConversation.provider} · {activeConversation.model}</span>
                    {thinkingLevel !== 'off' && (
                      <span
                        onClick={() => setThinkingLevel('off')}
                        title="Click to disable thinking mode"
                        style={{ fontSize: 10, background: 'rgba(16,185,129,0.12)', color: '#059669', padding: '2px 8px', borderRadius: 10, cursor: 'pointer', fontWeight: 600 }}
                      >
                        🧠 Think: {thinkingLevel}
                      </span>
                    )}
                  </div>
                  {/* Knowledge Base selector */}
                  {knowledgeBases.length > 0 && (
                    <div ref={kbDropdownRef} style={{ marginTop: 8, position: 'relative' }}>
                      <button
                        onClick={() => setShowKBSelector(!showKBSelector)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '5px 10px',
                          borderRadius: 6,
                          border: selectedKnowledgeBaseIds.length > 0 ? '1px solid var(--green)' : '1px solid var(--border)',
                          background: selectedKnowledgeBaseIds.length > 0 ? 'var(--green-bg)' : 'var(--bg)',
                          cursor: 'pointer',
                          fontSize: 12,
                          fontWeight: 500,
                          color: selectedKnowledgeBaseIds.length > 0 ? 'var(--green)' : 'var(--text-muted)'
                        }}
                      >
                        <Database size={12} />
                        {selectedKnowledgeBaseIds.length > 0
                          ? `Knowledge: ${selectedKnowledgeBaseIds.length} selected`
                          : 'Add knowledge base'}
                      </button>
                      {showKBSelector && (
                        <div
                          style={{
                            position: 'absolute',
                            top: '100%',
                            left: 0,
                            marginTop: 4,
                            background: 'var(--bg-white)',
                            border: '1px solid var(--border)',
                            borderRadius: 8,
                            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                            padding: 8,
                            minWidth: 240,
                            maxHeight: 200,
                            overflowY: 'auto',
                            zIndex: 100
                          }}
                        >
                          {knowledgeBases.map(kb => (
                            <label
                              key={kb.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: '6px 8px',
                                borderRadius: 4,
                                cursor: 'pointer',
                                fontSize: 12
                              }}
                              onMouseOver={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                              onMouseOut={e => { e.currentTarget.style.background = 'transparent' }}
                            >
                              <input
                                type="checkbox"
                                checked={selectedKnowledgeBaseIds.includes(kb.id)}
                                onChange={() => toggleKnowledgeBase(kb.id)}
                                style={{ accentColor: 'var(--green)' }}
                              />
                              <span style={{ flex: 1 }}>{kb.name}</span>
                              <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg)', padding: '1px 6px', borderRadius: 8 }}>
                                {kb.document_count ?? 0} docs
                              </span>
                            </label>
                          ))}
                          {knowledgeBases.length === 0 && (
                            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8, textAlign: 'center' }}>
                              No knowledge bases available
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {/* Knowledge Graph selector */}
                  {knowledgeGraphs.length > 0 && (
                    <div ref={graphDropdownRef} style={{ marginTop: 8, position: 'relative' }}>
                      <button
                        onClick={() => setShowGraphSelector(!showGraphSelector)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '5px 10px',
                          borderRadius: 6,
                          border: selectedGraphIds.length > 0 ? '1px solid var(--purple, #7c3aed)' : '1px solid var(--border)',
                          background: selectedGraphIds.length > 0 ? 'rgba(124,58,237,0.08)' : 'var(--bg)',
                          cursor: 'pointer',
                          fontSize: 12,
                          fontWeight: 500,
                          color: selectedGraphIds.length > 0 ? 'var(--purple, #7c3aed)' : 'var(--text-muted)'
                        }}
                      >
                        <GitFork size={12} />
                        {selectedGraphIds.length > 0
                          ? `Graph: ${selectedGraphIds.length} selected`
                          : 'Add graph'}
                      </button>
                      {showGraphSelector && (
                        <div
                          style={{
                            position: 'absolute',
                            top: '100%',
                            left: 0,
                            marginTop: 4,
                            background: 'var(--bg-white)',
                            border: '1px solid var(--border)',
                            borderRadius: 8,
                            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                            padding: 8,
                            minWidth: 240,
                            maxHeight: 200,
                            overflowY: 'auto',
                            zIndex: 100
                          }}
                        >
                          {knowledgeGraphs.map(g => (
                            <label
                              key={g.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: '6px 8px',
                                borderRadius: 4,
                                cursor: 'pointer',
                                fontSize: 12
                              }}
                              onMouseOver={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                              onMouseOut={e => { e.currentTarget.style.background = 'transparent' }}
                            >
                              <input
                                type="checkbox"
                                checked={selectedGraphIds.includes(g.id)}
                                onChange={() => toggleGraph(g.id)}
                                style={{ accentColor: 'var(--purple, #7c3aed)' }}
                              />
                              <span style={{ flex: 1 }}>{g.name}</span>
                              <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg)', padding: '1px 6px', borderRadius: 8 }}>
                                {g.entity_count ?? 0} entities
                              </span>
                            </label>
                          ))}
                          {knowledgeGraphs.length === 0 && (
                            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8, textAlign: 'center' }}>
                              No graphs available
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => deleteConversation(activeConversation.id)}
                  className="btn btn-secondary btn-sm"
                  style={{ padding: '4px 10px', fontSize: 12 }}
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>

              {/* Messages */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {loading ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 40 }}>
                    <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block', marginRight: 8 }}>⟳</span>
                    Loading messages...
                  </div>
                ) : messages.length === 0 ? (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: 40 }}>
                      No messages yet. Start the conversation!
                    </div>
                  </div>
                ) : (
                  messages.map(msg => (
                    <div
                      key={msg.id}
                      style={{
                        display: 'flex',
                        justifyContent: msg.role === 'user' ? 'flex-end' : msg.role === 'system' ? 'center' : 'flex-start'
                      }}
                    >
                      <div
                        style={{
                          maxWidth: msg.role === 'system' ? '90%' : '78%',
                          padding: '10px 14px',
                          borderRadius: msg.role === 'user' ? '12px 12px 4px 12px' : msg.role === 'system' ? '8px' : '12px 12px 12px 4px',
                          background: msg.role === 'user' ? 'var(--green)' : msg.role === 'system' ? 'rgba(16,185,129,0.06)' : 'var(--bg)',
                          color: msg.role === 'user' ? '#fff' : msg.role === 'system' ? '#059669' : 'var(--text)',
                          border: msg.role === 'assistant' ? '1px solid var(--border)' : msg.role === 'system' ? '1px dashed rgba(16,185,129,0.35)' : 'none',
                          boxShadow: msg.role === 'user' ? '0 2px 8px rgba(63,138,67,0.25)' : '0 1px 3px rgba(0,0,0,0.04)'
                        }}
                      >
                        <div style={{ fontSize: 13, lineHeight: 1.6 }} dangerouslySetInnerHTML={{
                          __html: renderMarkdown(msg.content)
                        }} />
                        <div style={{ fontSize: 10, marginTop: 6, opacity: 0.5, textAlign: msg.role === 'user' ? 'right' : 'left' }}>
                          {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Attachments Preview */}
              {attachments.length > 0 && (
                <div style={{ display: 'flex', gap: 8, padding: '8px 20px', background: 'var(--bg-white)', borderTop: '1px solid var(--border)' }}>
                  {attachments.map((att, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--bg)', padding: '4px 8px', borderRadius: 4, fontSize: 11, border: '1px solid var(--border)' }}>
                      <span>📎 {att.name}</span>
                      <button type="button" onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--danger)' }}>
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {/* Input */}
              <form onSubmit={sendMessage} style={{ flexShrink: 0, padding: '14px 20px', borderTop: '1px solid var(--border)', background: 'var(--bg)', position: 'relative' }}>
                {/* Slash command picker */}
                {showCommandMenu && (
                  <div ref={commandMenuRef} style={{
                    position: 'absolute',
                    bottom: '100%',
                    left: 20,
                    right: 20,
                    background: 'var(--bg-white)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    boxShadow: '0 -4px 20px rgba(0,0,0,0.1)',
                    marginBottom: 4,
                    overflow: 'hidden',
                    zIndex: 100,
                  }}>
                    {SLASH_COMMANDS.filter(c => c.cmd.startsWith(input.split(' ')[0] || '/')).map(c => (
                      <button
                        key={c.cmd}
                        type="button"
                        onClick={() => { setInput(c.cmd + (c.args ? ' ' : '')); setShowCommandMenu(false); inputRef.current?.focus() }}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 14px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                        onMouseOver={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                        onMouseOut={e => { e.currentTarget.style.background = 'transparent' }}
                      >
                        <code style={{ fontSize: 12, color: '#10b981', fontWeight: 700, background: 'rgba(16,185,129,0.1)', padding: '2px 8px', borderRadius: 4, flexShrink: 0 }}>{c.cmd}{c.args ? ` ${c.args}` : ''}</code>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.desc}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="file"
                    ref={fileInputRef}
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      const reader = new FileReader()
                      reader.onload = (ev) => {
                        const base64 = (ev.target?.result as string).split(',')[1]
                        setAttachments(prev => [...prev, { name: file.name, type: file.type || 'application/octet-stream', contentBase64: base64 }])
                      }
                      reader.readAsDataURL(file)
                      e.target.value = ''
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    title="Attach file"
                    style={{ padding: '8px 12px' }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Paperclip size={15} />
                  </button>
                  <input
                    ref={inputRef}
                    type="text"
                    className="input"
                    placeholder={streaming ? 'Waiting for response...' : 'Type a message or / for commands...'}
                    value={input}
                    onChange={(e) => { setInput(e.target.value); setShowCommandMenu(e.target.value.startsWith('/')) }}
                    onKeyDown={(e) => { if (e.key === 'Escape') { setShowCommandMenu(false) } }}
                    disabled={streaming}
                    style={{ flex: 1, fontSize: 13, background: 'var(--bg-white)' }}
                  />
                  <button
                    type="button"
                    onClick={startVoice}
                    title={listening ? 'Stop listening' : 'Voice input'}
                    style={{
                      padding: '8px 12px',
                      borderRadius: 8,
                      border: `1px solid ${listening ? '#ef4444' : 'var(--border)'}`,
                      background: listening ? 'rgba(239,68,68,0.1)' : 'var(--bg)',
                      color: listening ? '#ef4444' : 'var(--text-muted)',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      animation: listening ? 'pulse 1.5s infinite' : 'none',
                    }}
                  >
                    {listening ? <MicOff size={15} /> : <Mic size={15} />}
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={(!input.trim() && attachments.length === 0) || streaming}
                    title="Send message"
                    style={{ padding: '8px 16px' }}
                  >
                    <Send size={15} />
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
