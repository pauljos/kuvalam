#!/usr/bin/env node
/**
 * Test script to verify agent UI button functionality
 * Tests:
 * 1. Delete skill button API
 * 2. Cancel/stop task button API
 * 3. Agent configuration
 * 
 * Usage:
 *   node test_agent_buttons.mjs
 */

import fetch from 'node-fetch';
import readline from 'readline';

const API_URL = process.env.API_URL || 'http://localhost:3001/api/v1';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function prompt(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function login() {
  console.log('\n=== Login ===');
  const email = await prompt('Email: ');
  const password = await prompt('Password: ');

  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Login failed: ${err}`);
  }

  const data = await res.json();
  return {
    accessToken: data.data.accessToken,
    tenantId: data.data.tenants[0]?.id
  };
}

async function testDeleteSkill(accessToken, tenantId) {
  console.log('\n=== Test Delete Skill ===');
  
  // 1. List agents
  const agentsRes = await fetch(`${API_URL}/tenants/${tenantId}/agents`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const agentsData = await agentsRes.json();
  const agents = agentsData.data.agents;
  
  if (agents.length === 0) {
    console.log('❌ No agents found');
    return;
  }

  console.log(`Found ${agents.length} agent(s)`);
  agents.forEach((a, i) => console.log(`  ${i + 1}. ${a.name} (${a.id})`));
  
  const agentIdx = parseInt(await prompt('Select agent (number): ')) - 1;
  const agent = agents[agentIdx];

  // 2. Get agent details with skills
  const detailRes = await fetch(`${API_URL}/tenants/${tenantId}/agents/${agent.id}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const detailData = await detailRes.json();
  const agentDetail = detailData.data;

  if (!agentDetail.skills || agentDetail.skills.length === 0) {
    console.log('❌ Agent has no skills to delete');
    console.log('   Add a skill first via the UI');
    return;
  }

  console.log(`\nAgent "${agent.name}" has ${agentDetail.skills.length} skill(s):`);
  agentDetail.skills.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.name} - ${s.description} (${s.id})`);
  });

  const skillIdx = parseInt(await prompt('Select skill to delete (number): ')) - 1;
  const skill = agentDetail.skills[skillIdx];

  console.log(`\nAttempting to delete skill: ${skill.name} (${skill.id})`);
  
  // 3. Delete the skill
  const deleteRes = await fetch(`${API_URL}/tenants/${tenantId}/agents/${agent.id}/skills/${skill.id}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  if (!deleteRes.ok) {
    const err = await deleteRes.text();
    console.log(`❌ Delete failed: ${deleteRes.status} ${err}`);
    return;
  }

  const deleteData = await deleteRes.json();
  console.log('✅ Skill deleted successfully:', deleteData);
  
  // 4. Verify it's gone
  const verifyRes = await fetch(`${API_URL}/tenants/${tenantId}/agents/${agent.id}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const verifyData = await verifyRes.json();
  const remainingSkills = verifyData.data.skills || [];
  
  console.log(`\n✅ Verification: Agent now has ${remainingSkills.length} skill(s)`);
  const stillExists = remainingSkills.some(s => s.id === skill.id);
  if (stillExists) {
    console.log('❌ WARNING: Skill still appears in the list!');
  } else {
    console.log('✅ Skill successfully removed from database');
  }
}

async function testCancelTask(accessToken, tenantId) {
  console.log('\n=== Test Cancel Task ===');
  
  // 1. List agents
  const agentsRes = await fetch(`${API_URL}/tenants/${tenantId}/agents`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const agentsData = await agentsRes.json();
  const agents = agentsData.data.agents.filter(a => a.status === 'ACTIVE');
  
  if (agents.length === 0) {
    console.log('❌ No active agents found');
    return;
  }

  console.log(`Found ${agents.length} active agent(s)`);
  agents.forEach((a, i) => console.log(`  ${i + 1}. ${a.name} (${a.id})`));
  
  const agentIdx = parseInt(await prompt('Select agent (number): ')) - 1;
  const agent = agents[agentIdx];

  // 2. List tasks
  const tasksRes = await fetch(`${API_URL}/tenants/${tenantId}/agents/${agent.id}/tasks`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const tasksData = await tasksRes.json();
  const tasks = tasksData.data.tasks;

  const runningTasks = tasks.filter(t => t.status === 'RUNNING' || t.status === 'PENDING' || t.status === 'QUEUED');
  
  if (runningTasks.length === 0) {
    console.log('❌ No running tasks to cancel');
    console.log('   Start a task first via the UI');
    return;
  }

  console.log(`\nFound ${runningTasks.length} running/pending task(s):`);
  runningTasks.forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.goal.substring(0, 60)}... [${t.status}] (${t.id})`);
  });

  const taskIdx = parseInt(await prompt('Select task to cancel (number): ')) - 1;
  const task = runningTasks[taskIdx];

  console.log(`\nAttempting to cancel task: ${task.id}`);
  
  // 3. Cancel the task
  const cancelRes = await fetch(`${API_URL}/tenants/${tenantId}/agents/${agent.id}/tasks/${task.id}/cancel`, {
    method: 'POST',
    headers: { 
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!cancelRes.ok) {
    const err = await cancelRes.text();
    console.log(`❌ Cancel failed: ${cancelRes.status} ${err}`);
    return;
  }

  const cancelData = await cancelRes.json();
  console.log('✅ Task cancelled successfully:', cancelData);
  
  // 4. Verify status changed
  await new Promise(r => setTimeout(r, 1000)); // Wait 1 second
  
  const verifyRes = await fetch(`${API_URL}/tenants/${tenantId}/agents/${agent.id}/tasks/${task.id}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const verifyData = await verifyRes.json();
  const updatedTask = verifyData.data;
  
  console.log(`\n✅ Verification: Task status is now: ${updatedTask.status}`);
  if (updatedTask.status === 'CANCELLED') {
    console.log('✅ Task successfully cancelled in database');
  } else {
    console.log('❌ WARNING: Task status did not change to CANCELLED!');
  }
}

async function testOllamaConfig(accessToken, tenantId) {
  console.log('\n=== Test Ollama Configuration ===');
  
  // 1. Get settings
  const settingsRes = await fetch(`${API_URL}/tenants/${tenantId}/settings`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const settingsData = await settingsRes.json();
  const llmConfig = settingsData.data.llm_config;
  
  console.log('\nConfigured LLM Providers:');
  if (!llmConfig || !llmConfig.providers || Object.keys(llmConfig.providers).length === 0) {
    console.log('  None configured');
  } else {
    Object.entries(llmConfig.providers).forEach(([key, value]) => {
      console.log(`  - ${key}: ${value.model || 'no model'}`);
    });
  }

  const hasOllama = llmConfig?.providers?.ollama;
  if (hasOllama) {
    console.log('\n✅ Ollama is configured:');
    console.log(`   Model: ${hasOllama.model}`);
    console.log(`   Base URL: ${hasOllama.baseUrl || 'default'}`);
  } else {
    console.log('\n❌ Ollama is NOT configured');
    console.log('   Go to Settings → LLM Providers → Configure Ollama');
  }

  // 2. List agents using Ollama
  const agentsRes = await fetch(`${API_URL}/tenants/${tenantId}/agents`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const agentsData = await agentsRes.json();
  const agents = agentsData.data.agents;
  
  const ollamaAgents = agents.filter(a => a.llm_provider === 'ollama');
  
  if (ollamaAgents.length > 0) {
    console.log(`\n✅ Found ${ollamaAgents.length} agent(s) using Ollama:`);
    ollamaAgents.forEach(a => {
      console.log(`   - ${a.name}: ${a.llm_model}`);
    });
  } else {
    console.log('\n❌ No agents are using Ollama');
  }

  // 3. Explain the Ollama model selection behavior
  console.log('\n📖 How Ollama Models Work in Agent Config:');
  console.log('   1. In Settings → Ollama is a TEXT INPUT (not dropdown)');
  console.log('   2. In Agent Config → Shows DROPDOWN only if custom fine-tuned models exist');
  console.log('   3. Otherwise → Shows TEXT INPUT where you type model name (e.g. llama3.2)');
  console.log('   4. This is BY DESIGN - base Ollama models are free-form text');
  console.log('\n💡 To see available Ollama models:');
  console.log('   Run: ollama list');
  console.log('   Then type the exact model name in the agent config');
}

async function main() {
  console.log('🧪 Agent UI Button Test Script\n');
  
  try {
    const { accessToken, tenantId } = await login();
    console.log(`\n✅ Logged in successfully`);
    console.log(`   Tenant ID: ${tenantId}`);

    while (true) {
      console.log('\n=== Test Options ===');
      console.log('1. Test Delete Skill Button');
      console.log('2. Test Cancel Task Button');
      console.log('3. Test Ollama Configuration');
      console.log('4. Exit');
      
      const choice = await prompt('\nSelect option (1-4): ');
      
      switch (choice.trim()) {
        case '1':
          await testDeleteSkill(accessToken, tenantId);
          break;
        case '2':
          await testCancelTask(accessToken, tenantId);
          break;
        case '3':
          await testOllamaConfig(accessToken, tenantId);
          break;
        case '4':
          console.log('\n👋 Goodbye!');
          rl.close();
          process.exit(0);
        default:
          console.log('Invalid choice');
      }
    }
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    rl.close();
    process.exit(1);
  }
}

main();
