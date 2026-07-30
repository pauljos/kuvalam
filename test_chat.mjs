#!/usr/bin/env node
/**
 * Test script for LLM Chat functionality
 * Tests creating conversations and sending messages to verify custom models work
 */

const API_BASE = process.env.API_URL || 'http://localhost:3001/api/v1'

async function apiCall(method, path, body = null, token = null) {
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const opts = { method, headers }
    if (body) opts.body = JSON.stringify(body)

    const res = await fetch(`${API_BASE}${path}`, opts)
    const data = await res.json()

    if (!res.ok) {
        throw new Error(data.error?.message || `HTTP ${res.status}`)
    }

    return data.data
}

async function main() {
    console.log('🧪 Testing Chat with LLM\n')

    // Login
    console.log('1️⃣  Logging in...')
    const auth = await apiCall('POST', '/auth/login', {
        email: 'admin@example.com',
        password: 'password'
    })
    const token = auth.accessToken
    const tenantId = auth.tenants[0].id
    console.log(`   ✅ Logged in as ${auth.user.email}`)
    console.log(`   📦 Tenant: ${auth.tenants[0].name} (${tenantId})\n`)

    // Get settings to check LLM configuration
    console.log('2️⃣  Checking LLM configuration...')
    const settings = await apiCall('GET', `/tenants/${tenantId}/settings`, null, token)
    const llmConfig = settings.llm_config

    if (!llmConfig?.providers || Object.keys(llmConfig.providers).length === 0) {
        console.log('   ⚠️  No LLM providers configured')
        console.log('   Please configure an LLM provider in Settings first')
        process.exit(1)
    }

    const defaultProvider = llmConfig.defaultProvider || Object.keys(llmConfig.providers)[0]
    const defaultModel = llmConfig.providers[defaultProvider]?.model
    console.log(`   ✅ Default provider: ${defaultProvider}`)
    console.log(`   ✅ Default model: ${defaultModel}\n`)

    // Create a conversation
    console.log('3️⃣  Creating chat conversation...')
    const conversation = await apiCall('POST', `/tenants/${tenantId}/chat/conversations`, {
        title: 'Test Chat Session',
        model: defaultModel,
        provider: defaultProvider
    }, token)
    console.log(`   ✅ Created conversation: ${conversation.conversation.id}\n`)

    // Send a test message
    console.log('4️⃣  Sending test message...')
    const testMessage = 'Hello! Please respond with a brief greeting.'
    console.log(`   📝 Message: "${testMessage}"`)

    try {
        const response = await apiCall(
            'POST',
            `/tenants/${tenantId}/chat/conversations/${conversation.conversation.id}/messages`,
            { content: testMessage },
            token
        )
        console.log(`   ✅ Message sent successfully\n`)

        // Get messages from the conversation
        console.log('5️⃣  Retrieving conversation messages...')
        const messages = await apiCall(
            'GET',
            `/tenants/${tenantId}/chat/conversations/${conversation.conversation.id}/messages`,
            null,
            token
        )

        console.log(`   ✅ Retrieved ${messages.messages.length} messages:\n`)

        for (const msg of messages.messages) {
            const role = msg.role === 'user' ? '👤 You' : '🤖 Assistant'
            console.log(`   ${role}: ${msg.content.substring(0, 100)}${msg.content.length > 100 ? '...' : ''}`)
        }

        console.log('\n✅ Chat test completed successfully!')
        console.log('\n💡 You can now test the chat UI at: http://localhost:3000/dashboard/chat')

    } catch (err) {
        console.error(`   ❌ Failed to send message: ${err.message}`)
        console.error('   This might mean the LLM provider is not properly configured or unavailable')
    }

    // List all conversations
    console.log('\n6️⃣  Listing all conversations...')
    const allConversations = await apiCall('GET', `/tenants/${tenantId}/chat/conversations`, null, token)
    console.log(`   ✅ Found ${allConversations.conversations.length} conversation(s)`)
}

main().catch(err => {
    console.error('❌ Test failed:', err.message)
    process.exit(1)
})
