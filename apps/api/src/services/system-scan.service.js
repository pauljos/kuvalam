// apps/api/src/services/system-scan.service.js
// System dependency scanner — checks for required/recommended software
// packages and can optionally attempt installation (macOS/Linux only).
//
// Used by the Settings → System Scan tab for local deployments.

import { execSync } from 'child_process'
import os from 'os'

// ─── Resolve pg connection details ─────────────────────────────────────────
// Priority: explicit env vars → parse DATABASE_URL → defaults
function resolvePgCreds() {
  if (process.env.PGHOST && process.env.PGUSER) {
    return {
      host: process.env.PGHOST,
      port: process.env.PGPORT || '5434',
      user: process.env.PGUSER,
      database: process.env.PGDATABASE || 'kuvalam_db',
    }
  }
  const url = process.env.DATABASE_URL || ''
  const m = url.match(/postgres(?:ql)?:\/\/([^:]+):[^@]+@([^:]+):(\d+)\/(.+)/)
  if (m) {
    return { user: m[1], host: m[2], port: m[3], database: m[4] }
  }
  return { host: 'localhost', port: '5434', user: 'kuvalam', database: 'kuvalam_db' }
}
const _pgCreds = resolvePgCreds()

// ─── OS detection ─────────────────────────────────────────────────────────
export function detectOS() {
  const platform = os.platform() // 'darwin' | 'linux' | 'win32'
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux') return 'linux'
  return 'unsupported'
}

function getOSLabel() {
  const p = os.platform()
  if (p === 'darwin') return `macOS ${os.release()}`
  if (p === 'linux') return `Linux ${os.release()}`
  return `${p} ${os.release()}`
}

// ─── Safe command runner ───────────────────────────────────────────────────
// Runs a shell command with a 5s timeout, returns stdout or null on failure.
function runQuiet(cmd) {
  try {
    const out = execSync(cmd, { timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return out.toString('utf8').trim()
  } catch {
    return null
  }
}

// Extract a clean version string from common --version outputs.
function extVer(raw) {
  if (!raw) return null
  // Strip leading non-digit junk (e.g. "node v", "Python ")
  const m = raw.match(/(\d+\.\d+[^\s,\]]*)/)
  return m ? m[1] : raw.split('\n')[0].trim().slice(0, 60)
}

// ─── Dependency registry ───────────────────────────────────────────────────
//
// Each entry:
//   id            – unique key
//   name          – human label
//   category      – 'runtime' | 'devtools' | 'infra' | 'ml'
//   required      – true = mandatory for core operation, false = optional
//   check         – shell command; return non-zero → "not installed"
//   versionCmd    – shell command that emits a version string
//   install       – { macos?, linux? } CLI install instructions
//   installUrl    – manual download URL (fallback)
//   description   – what this package enables
//   homebrew      – brew package name (only for macOS)
//
const DEPENDENCIES = [
  {
    id: 'nodejs',
    name: 'Node.js',
    category: 'runtime',
    required: true,
    check: 'which node || which nodejs',
    versionCmd: 'node --version',
    install: {
      macos: 'brew install node',
      linux: 'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs'
    },
    installUrl: 'https://nodejs.org/en/download',
    description: 'JavaScript runtime — required to run the API server, worker, and dashboard.'
  },
  {
    id: 'npm',
    name: 'npm (Node Package Manager)',
    category: 'runtime',
    required: true,
    check: 'which npm',
    versionCmd: 'npm --version',
    install: {
      macos: 'brew install node', // npm ships with node
      linux: '(comes with Node.js)'
    },
    installUrl: null,
    description: 'Package manager for JavaScript — required to install project dependencies.'
  },
  {
    id: 'python3',
    name: 'Python 3',
    category: 'ml',
    required: true,
    check: 'which python3 || which python',
    versionCmd: 'python3 --version 2>&1 || python --version 2>&1',
    install: {
      macos: 'brew install python@3.13',
      linux: 'sudo apt-get install -y python3 python3-pip'
    },
    installUrl: 'https://www.python.org/downloads/',
    description: 'Required for LLM training pipeline (fine-tuning). Version 3.10+ recommended.'
  },
  {
    id: 'pip',
    name: 'pip (Python Package Installer)',
    category: 'ml',
    required: true,
    check: 'which pip3 || which pip',
    versionCmd: 'pip3 --version 2>&1 || pip --version 2>&1',
    install: {
      macos: 'python3 -m ensurepip --upgrade',
      linux: 'sudo apt-get install -y python3-pip'
    },
    installUrl: null,
    description: 'Python package installer — needed to install ML libraries (torch, transformers, etc.).'
  },
  {
    id: 'git',
    name: 'Git',
    category: 'devtools',
    required: true,
    check: 'which git',
    versionCmd: 'git --version',
    install: {
      macos: 'brew install git',
      linux: 'sudo apt-get install -y git'
    },
    installUrl: 'https://git-scm.com/downloads',
    description: 'Version control — required to clone the repository and manage code.'
  },
  {
    id: 'docker',
    name: 'Docker',
    category: 'infra',
    required: false,
    check: 'which docker || (docker --version 2>/dev/null)',
    versionCmd: 'docker --version 2>/dev/null',
    install: {
      macos: 'brew install --cask docker',
      linux: 'curl -fsSL https://get.docker.com | sh'
    },
    installUrl: 'https://www.docker.com/products/docker-desktop/',
    description: 'Container runtime — required for PostgreSQL, Redis, and MailHog. Highly recommended.'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    category: 'ml',
    required: false,
    check: 'which ollama',
    versionCmd: 'ollama --version 2>&1',
    install: {
      macos: 'brew install ollama',
      linux: 'curl -fsSL https://ollama.com/install.sh | sh'
    },
    installUrl: 'https://ollama.com/download',
    description: 'Local LLM inference engine — required to run and serve fine-tuned models.'
  },
  {
    id: 'brew',
    name: 'Homebrew',
    category: 'devtools',
    required: false,
    check: 'which brew',
    versionCmd: 'brew --version 2>&1 | head -1',
    install: {
      macos: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
      linux: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    },
    installUrl: 'https://brew.sh',
    description: 'macOS/Linux package manager — makes installing dependencies much easier.'
  },
  {
    id: 'gpu',
    name: 'CUDA / NVIDIA GPU',
    category: 'ml',
    required: false,
    check: 'which nvidia-smi',
    versionCmd: 'nvidia-smi --query-gpu=driver_version,name --format=csv,noheader 2>/dev/null || echo "No NVIDIA GPU detected"',
    install: null,
    installUrl: 'https://developer.nvidia.com/cuda-downloads',
    description: 'Dramatically speeds up model training (10-50× faster than CPU). Optional but strongly recommended for production.'
  },
  {
    id: 'psql',
    name: 'PostgreSQL Client (psql)',
    category: 'infra',
    required: false,
    check: 'which psql',
    versionCmd: 'psql --version 2>&1',
    install: {
      macos: 'brew install libpq && brew link --force libpq',
      linux: 'sudo apt-get install -y postgresql-client'
    },
    installUrl: null,
    description: 'PostgreSQL CLI — useful for direct DB inspection and debugging.'
  },
  {
    id: 'redis',
    name: 'Redis CLI',
    category: 'infra',
    required: false,
    check: 'which redis-cli',
    versionCmd: 'redis-cli --version 2>&1',
    install: {
      macos: 'brew install redis',
      linux: 'sudo apt-get install -y redis-tools'
    },
    installUrl: null,
    description: 'Redis client — useful for inspecting job queues and cache (if using Redis).'
  }
]

// ─── HTTP helper ──────────────────────────────────────────────────────────
// Lightweight HTTP GET (no dependency on fetch in older Node versions)
import http from 'http'
import https from 'https'

function httpGet(url, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }) }
        catch { resolve({ status: res.statusCode, body: null }) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

// ─── Runtime health checks (dynamic — not just binary presence) ────────────
async function runServiceChecks() {
  const checks = []

  // ── Ollama: list available models ──────────────────────────────────────
  const ollamaBinary = runQuiet('which ollama')
  if (ollamaBinary) {
    try {
      const res = await httpGet('http://localhost:11434/api/tags')
      if (res && res.body?.models) {
        const models = res.body.models.map(m => `${m.name} (${(m.size / 1e9).toFixed(1)} GB)`)
        checks.push({
          id: 'ollama-models',
          name: 'Ollama Models',
          category: 'services',
          required: false,
          installed: true,
          version: models.length > 0 ? models.join(', ') : 'No models pulled',
          installHint: null,
          installUrl: null,
          description: `Available local LLM models served by Ollama. ${models.length} model(s) found.`
        })
      } else {
        checks.push({
          id: 'ollama-models',
          name: 'Ollama Models',
          category: 'services',
          required: false,
          installed: false,
          version: 'Ollama running but no models returned',
          installHint: 'ollama pull qwen2.5:14b',
          installUrl: 'https://ollama.com/library',
          description: 'No models are pulled in Ollama. Pull at least one model (e.g. qwen2.5:14b) from ollama.com/library.'
        })
      }
    } catch {
      checks.push({
        id: 'ollama-models',
        name: 'Ollama Models',
        category: 'services',
        required: false,
        installed: false,
        version: 'Error querying Ollama API',
        installHint: 'ollama serve',
        installUrl: 'https://ollama.com/download',
        description: 'Ollama binary found but API is unreachable. Make sure "ollama serve" is running.'
      })
    }
  } else {
    checks.push({
      id: 'ollama-models',
      name: 'Ollama Models',
      category: 'services',
      required: false,
      installed: false,
      version: 'Ollama not installed',
      installHint: null,
      installUrl: 'https://ollama.com/download',
      description: 'Ollama is not installed. Install it to run local LLM models.'
    })
  }

  // ── Browser Agent (Playwright sidecar) ─────────────────────────────────
  const baRes = await httpGet('http://localhost:9223/health')
  checks.push({
    id: 'browser-agent',
    name: 'Browser Agent (Playwright)',
    category: 'services',
    required: false,
    installed: !!(baRes && baRes.body),
    version: baRes?.body?.browser === 'connected' ? 'Browser connected ✓' : baRes?.body?.status || 'Not responding',
    installHint: 'cd apps/browser-agent && node server.js',
    installUrl: null,
    description: 'Playwright browser controller for web automation (browser_use tool). Required for data entry and research agents.'
  })

  // ── Docker containers running ──────────────────────────────────────────
  const dockerPs = runQuiet('docker ps --format "{{.Names}}: {{.Status}}" 2>/dev/null')
  if (dockerPs) {
    const containers = dockerPs.split('\n').filter(Boolean)
    checks.push({
      id: 'docker-containers',
      name: 'Docker Containers',
      category: 'services',
      required: true,
      installed: containers.length > 0,
      version: containers.length > 0 ? containers.join(' | ') : 'No containers running',
      installHint: 'docker compose up -d',
      installUrl: null,
      description: `Running Docker containers. ${containers.length} container(s) active.`
    })
  } else {
    checks.push({
      id: 'docker-containers',
      name: 'Docker Containers',
      category: 'services',
      required: true,
      installed: false,
      version: 'Docker not available or not running',
      installHint: 'docker compose up -d',
      installUrl: 'https://www.docker.com/products/docker-desktop/',
      description: 'Docker containers (PostgreSQL, Redis, MailHog) are not running. These are required for core operation.'
    })
  }

  // ── pgvector container (Knowledge Base backend) ────────────────────────
  const PG_CONTAINER = process.env.K8_PGVECTOR_CONTAINER || 'kuvalam-postgres'
  const pgContainerName = runQuiet(`docker inspect -f '{{.Name}}' "${PG_CONTAINER}" 2>/dev/null`)
  const pgRunning = runQuiet(`docker inspect -f '{{.State.Status}}' "${PG_CONTAINER}" 2>/dev/null`) === 'running'
  let pgHasVector = false
  if (pgRunning) {
    const vectorCheck = runQuiet(
      `docker exec "${PG_CONTAINER}" psql -U "${_pgCreds.user}" -d "${_pgCreds.database}" -c "SELECT count(*) FROM pg_extension WHERE extname='vector'" -t 2>/dev/null`
    )
    pgHasVector = vectorCheck && vectorCheck.includes('1')
  }
  checks.push({
    id: 'pgvector-container',
    name: 'pgvector (Vector DB)',
    category: 'services',
    required: false,
    installed: pgRunning && pgHasVector,
    version: pgRunning
      ? (pgHasVector ? `✅ Healthy (${PG_CONTAINER})` : `⚠️ Running but pgvector extension not loaded`)
      : (pgContainerName ? `❌ Container exists but not running` : `❌ Container "${PG_CONTAINER}" not found`),
    installHint: pgContainerName
      ? `docker start ${PG_CONTAINER}`
      : 'docker compose up -d postgres',
    installUrl: null,
    description: `pgvector container for semantic search & RAG. ${pgRunning && pgHasVector ? 'Ready for Knowledge Bases.' : 'Not available — Knowledge Bases cannot store documents without this.'}`
  })

  // ── Neo4j container (Knowledge Graph backend) ──────────────────────────
  const NEO4J_CONTAINER = process.env.K8_NEO4J_CONTAINER || 'kuvalam-neo4j'
  const neo4jContainerName = runQuiet(`docker inspect -f '{{.Name}}' "${NEO4J_CONTAINER}" 2>/dev/null`)
  const neo4jRunning = runQuiet(`docker inspect -f '{{.State.Status}}' "${NEO4J_CONTAINER}" 2>/dev/null`) === 'running'
  let neo4jHealthy = false
  if (neo4jRunning) {
    try {
      const NEO4J_HOST = process.env.NEO4J_HOST || 'localhost'
      const NEO4J_HTTP_PORT = process.env.NEO4J_HTTP_PORT || '7474'
      const resp = await httpGet(`http://${NEO4J_HOST}:${NEO4J_HTTP_PORT}`, 5_000)
      neo4jHealthy = resp && resp.status >= 200 && resp.status < 400
    } catch { neo4jHealthy = false }
  }
  checks.push({
    id: 'neo4j-container',
    name: 'Neo4j (Knowledge Graph)',
    category: 'services',
    required: false,
    installed: neo4jRunning && neo4jHealthy,
    version: neo4jRunning
      ? (neo4jHealthy ? `✅ Healthy (${NEO4J_CONTAINER})` : `⚠️ Running but not responding on HTTP`)
      : (neo4jContainerName ? `❌ Container exists but not running` : `⚠️ Container "${NEO4J_CONTAINER}" not found (optional)`),
    installHint: neo4jContainerName
      ? `docker start ${NEO4J_CONTAINER}`
      : 'docker compose --profile graph up -d neo4j',
    installUrl: null,
    description: `Neo4j graph database for entity-relationship traversal. ${neo4jRunning && neo4jHealthy ? 'Ready for Knowledge Graphs.' : 'Not available — Knowledge Graphs cannot function without this (optional).'}`
  })

  // ── Disk space ─────────────────────────────────────────────────────────
  const osType = detectOS()
  const diskCmd = osType === 'macos'
    ? "df -h / | tail -1 | awk '{print $4 \" free of \" $2 \" (\" $5 \" used)\"}'"
    : "df -h / | tail -1 | awk '{print $4 \" free of \" $2 \" (\" $5 \" used)\"}'"
  const diskOut = runQuiet(diskCmd)
  checks.push({
    id: 'disk-space',
    name: 'Disk Space (root)',
    category: 'services',
    required: false,
    installed: true,
    version: diskOut || 'Unable to check',
    installHint: null,
    installUrl: null,
    description: 'Available disk space on the root volume. Critical for training datasets and artifact storage.'
  })

  // ── Memory ─────────────────────────────────────────────────────────────
  const memCmd = osType === 'macos'
    ? "sysctl hw.memsize 2>/dev/null | awk '{printf \"%.1f GB total\", $2/1073741824}'"
    : "free -h 2>/dev/null | awk '/^Mem:/ {print $2 \" total, \" $7 \" available\"}'"
  const memOut = runQuiet(memCmd) || 'Unable to check'
  checks.push({
    id: 'memory',
    name: 'System Memory',
    category: 'services',
    required: false,
    installed: true,
    version: memOut,
    installHint: null,
    installUrl: null,
    description: 'Total system memory. LLM inference (especially 14B+ models) requires at least 8 GB RAM.'
  })

  return checks
}

// ─── Scan ──────────────────────────────────────────────────────────────────

/**
 * Scan all registered dependencies plus runtime service health.
 * Returns { os, hostname, results: [{ id, name, category, required, installed, version, installHint, installUrl }] }
 */
export async function scanDependencies() {
  const osType = detectOS()
  const results = []

  for (const dep of DEPENDENCIES) {
    let installed = false
    let version = null

    // 1. Check if the binary exists
    const checkOut = runQuiet(dep.check)
    if (checkOut !== null) {
      installed = true
      // 2. Try to get the version
      if (dep.versionCmd) {
        const verOut = runQuiet(dep.versionCmd)
        version = extVer(verOut)
      }
    }

    // 3. Build install hint for this OS
    let installHint = null
    if (!installed && dep.install) {
      installHint = dep.install[osType] || dep.install.linux || dep.install.macos || null
    }

    results.push({
      id: dep.id,
      name: dep.name,
      category: dep.category,
      required: dep.required,
      installed,
      version: version || null,
      installHint,
      installUrl: dep.installUrl || null,
      description: dep.description
    })
  }

  // Run runtime service checks (HTTP health, API queries, disk/mem)
  try {
    const serviceChecks = await runServiceChecks()
    results.push(...serviceChecks)
  } catch {
    // If service checks fail entirely, don't block the scan
  }

  return {
    os: getOSLabel(),
    hostname: os.hostname(),
    results
  }
}

// ─── Install ───────────────────────────────────────────────────────────────

const INSTALL_TIMEOUT = 120_000 // 2 minutes for package installs

/**
 * Attempt to install a single dependency.
 * Returns { success, output, depId, alreadyInstalled }.
 *
 * ⚠️ SAFETY: Only whitelisted dependencies are installable.
 * Only macOS (brew) and Linux (apt) are supported for auto-install.
 * GPU (CUDA), npm, and other complex installs redirect to manual instructions.
 */
export async function installDependency(depId) {
  const dep = DEPENDENCIES.find(d => d.id === depId)
  if (!dep) {
    return { success: false, output: `Unknown dependency: ${depId}`, depId, alreadyInstalled: false }
  }

  // Check if already installed
  if (runQuiet(dep.check) !== null) {
    return { success: true, output: `${dep.name} is already installed.`, depId, alreadyInstalled: true }
  }

  const osType = detectOS()
  if (osType === 'unsupported') {
    return {
      success: false,
      output: `Automatic installation is only supported on macOS and Linux. Please install ${dep.name} manually.`,
      depId,
      alreadyInstalled: false,
      installUrl: dep.installUrl
    }
  }

  // Dependencies that should not be auto-installed
  const NO_AUTO_INSTALL = ['gpu', 'docker']
  if (NO_AUTO_INSTALL.includes(dep.id)) {
    return {
      success: false,
      output: `Automatic installation of ${dep.name} is not supported. Please visit: ${dep.installUrl}`,
      depId,
      alreadyInstalled: false,
      installUrl: dep.installUrl
    }
  }

  if (!dep.install || !dep.install[osType]) {
    return {
      success: false,
      output: `No install instructions available for ${dep.name} on ${osType}. Please install manually.`,
      depId,
      alreadyInstalled: false,
      installUrl: dep.installUrl
    }
  }

  try {
    const cmd = dep.install[osType]
    const output = execSync(cmd, {
      timeout: INSTALL_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } // suppress apt prompts
    }).toString('utf8').trim()

    // Verify after install
    const verifyOut = runQuiet(dep.check)
    const ok = verifyOut !== null

    return {
      success: ok,
      output: ok
        ? `${dep.name} installed successfully. Version: ${extVer(runQuiet(dep.versionCmd)) || 'unknown'}`
        : `${dep.name} installation may have failed. Please verify manually. Output:\n${output.slice(0, 500)}`,
      depId,
      alreadyInstalled: false
    }
  } catch (err) {
    return {
      success: false,
      output: `Failed to install ${dep.name}: ${err.message}\n\nPlease install manually: ${dep.installUrl || dep.install[osType]}`,
      depId,
      alreadyInstalled: false,
      installUrl: dep.installUrl
    }
  }
}
