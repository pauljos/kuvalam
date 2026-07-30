'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { api, API } from '@/lib/api'
import { useApp } from '@/lib/context'
import { useConfirm } from '@/components/ConfirmModal'

export default function KnowledgePage() {
  const { tenantId, toast } = useApp()
  const { confirm, ConfirmDialog } = useConfirm()
  const [kbs, setKbs] = useState<any[]>([])
  const [selectedKB, setSelectedKB] = useState<any>(null)
  const [docs, setDocs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  // Forms
  const [showCreate, setShowCreate] = useState(false)
  const [kbForm, setKbForm] = useState({ name: '', description: '' })
  const [creating, setCreating] = useState(false)

  const [docForm, setDocForm] = useState({ title: '', content: '' })
  const [addingDoc, setAddingDoc] = useState(false)

  // File upload
  const [ingestTab, setIngestTab] = useState<'paste' | 'upload'>('paste')
  const [dragOver, setDragOver] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Search
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [searchTopK, setSearchTopK] = useState(5)
  const [searchThreshold, setSearchThreshold] = useState(0.45)
  const [expandedResults, setExpandedResults] = useState<Set<number>>(new Set())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Tab (Knowledge Bases vs Graphs)
  const [tab, setTab] = useState<'knowledge_bases' | 'knowledge_graphs'>('knowledge_bases')
  const [graphs, setGraphs] = useState<any[]>([])
  const [selectedGraph, setSelectedGraph] = useState<any>(null)
  const [graphEntities, setGraphEntities] = useState<any[]>([])
  const [showCreateGraph, setShowCreateGraph] = useState(false)
  const [graphForm, setGraphForm] = useState({ name: '', description: '' })
  const [creatingGraph, setCreatingGraph] = useState(false)
  const [addEntityForm, setAddEntityForm] = useState({ label: '', type: '' })
  const [addingEntity, setAddingEntity] = useState(false)

  // DB → Graph import state
  const [showDBImport, setShowDBImport] = useState(false)
  const [dbSchema, setDbSchema] = useState<any>(null)
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set())
  const [importLimit, setImportLimit] = useState(500)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<any>(null)
  const [selectedGraphDBConnection, setSelectedGraphDBConnection] = useState('internal')
  const [dbSources, setDbSources] = useState<any[]>([])

  // DB → KB import state
  const [showKBDBImport, setShowKBDBImport] = useState(false)
  const [kbDBSchema, setKbDBSchema] = useState<any>(null)
  const [kbSchemaLoading, setKbSchemaLoading] = useState(false)
  const [kbSelectedTables, setKbSelectedTables] = useState<Set<string>>(new Set())
  const [kbImportLimit, setKbImportLimit] = useState(500)
  const [kbRowsPerDoc, setKbRowsPerDoc] = useState(200)
  const [kbImporting, setKbImporting] = useState(false)
  const [kbImportResult, setKbImportResult] = useState<any>(null)
  const [selectedKBDBConnection, setSelectedKBDBConnection] = useState('internal')

  useEffect(() => {
    if (tenantId) loadKBs(tenantId)
  }, [tenantId])

  async function loadGraphs(tid: string) {
    try {
      const res = await api.listKnowledgeGraphs(tid)
      setGraphs(res.knowledgeGraphs || [])
    } catch (err) { console.error('Failed to load graphs', err) }
  }

  useEffect(() => {
    if (tenantId && tab === 'knowledge_graphs') loadGraphs(tenantId)
  }, [tenantId, tab])

  async function loadKBs(tid: string) {
    try {
      const res = await api.listKBs(tid)
      setKbs(res.knowledgeBases || [])
      if (res.knowledgeBases?.length > 0) {
        selectKB(tid, res.knowledgeBases[0])
      }
    } finally { setLoading(false) }
  }

  async function selectKB(tid: string, kb: any) {
    setSelectedKB(kb)
    setDocs([])
    setResults([])
    setQuery('')
    try {
      const res = await api.listDocuments(tid, kb.id)
      setDocs(res.documents || [])
    } catch (err) { console.error(err); toast('error', 'Failed to load documents', (err as any)?.message || '') }
  }

  async function createKB(e: any) {
    e.preventDefault(); setCreating(true)
    try {
      const kb = await api.createKB(tenantId, kbForm)
      setKbs(prev => [...prev, kb])
      setShowCreate(false)
      setKbForm({ name: '', description: '' })
      selectKB(tenantId, kb)
      toast('success', 'Knowledge base created', `"${kb.name}" is ready for documents.`)
    } catch (err) { toast('error', 'Create failed', (err as any).message) } finally { setCreating(false) }
  }

  async function createGraph(e: any) {
    e.preventDefault(); setCreatingGraph(true)
    try {
      const graph = await api.createKnowledgeGraph(tenantId, { ...graphForm, graphKind: 'neo4j' })
      setGraphs(prev => [...prev, graph])
      setShowCreateGraph(false)
      setGraphForm({ name: '', description: '' })
      toast('success', 'Knowledge graph created', `"${graph.name}" is ready.`)
    } catch (err) { toast('error', 'Create failed', (err as any).message) } finally { setCreatingGraph(false) }
  }

  async function deleteGraph(graphId: string, graphName: string) {
    const ok = await confirm({
      title: 'Delete Knowledge Graph',
      description: `Are you sure you want to delete "${graphName}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (!ok) return
    try {
      await api.deleteKnowledgeGraph(tenantId, graphId)
      setGraphs(prev => prev.filter(g => g.id !== graphId))
      toast('success', 'Graph deleted', `"${graphName}" has been removed.`)
    } catch (err) { toast('error', 'Delete failed', (err as any).message) }
  }

  async function addDocument(e: any) {
    e.preventDefault(); setAddingDoc(true)
    try {
      await api.addDocument(tenantId, selectedKB.id, docForm)
      setDocForm({ title: '', content: '' })
      // Reload docs
      const res = await api.listDocuments(tenantId, selectedKB.id)
      setDocs(res.documents || [])
      // Update kb count locally
      setKbs(prev => prev.map(k => k.id === selectedKB.id ? { ...k, document_count: (k.document_count || 0) + 1 } : k))
      toast('success', 'Document added', 'The document has been indexed and is ready for search.')
    } catch (err) { toast('error', 'Upload failed', (err as any).message) } finally { setAddingDoc(false) }
  }

  async function search(e: any) {
    e.preventDefault()
    if (!query.trim()) return
    if (!selectedKB) { toast('error', 'No KB selected', 'Please select a knowledge base first.'); return }
    setSearching(true)
    setHasSearched(true)
    try {
      const res = await api.searchKB(tenantId, selectedKB.id, { query, topK: searchTopK, threshold: searchThreshold })
      setResults(res.chunks || [])
    } catch (err) { toast('error', 'Search failed', (err as any).message) } finally { setSearching(false) }
  }

  // Debounced search as user types
  const debouncedSearch = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!q.trim() || !selectedKB) { setResults([]); setHasSearched(false); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      setHasSearched(true)
      try {
        const res = await api.searchKB(tenantId, selectedKB.id, { query: q, topK: searchTopK, threshold: searchThreshold })
        setResults(res.chunks || [])
      } catch { /* silent fail for auto-search */ } finally { setSearching(false) }
    }, 400)
  }, [tenantId, selectedKB, searchTopK, searchThreshold])

  async function uploadDocument() {
    const files = uploadFiles.length > 0 ? uploadFiles : (uploadFile ? [uploadFile] : [])
    if (files.length === 0 || !selectedKB) return
    try {
    const MAX_BYTES = 50 * 1024 * 1024
    const allowed = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.txt', '.md', '.csv']

    // Validate all files first
    for (const f of files) {
      const ext = '.' + (f.name.split('.').pop() || '').toLowerCase()
      if (!allowed.includes(ext)) {
        toast('error', `Unsupported file type`, `"${f.name}" — only ${allowed.join(', ')} files are supported.`)
        return
      }
      if (f.size > MAX_BYTES) {
        toast('error', `File too large`, `"${f.name}" exceeds the 50 MB limit.`)
        return
      }
    }

    setUploading(true)
    setUploadProgress(0)
    const totalFiles = files.length
    let completedFiles = 0

    for (const file of files) {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('knowledgeBaseId', selectedKB.id)

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `${API}/tenants/${tenantId}/knowledge-bases/${selectedKB.id}/documents/upload`)
        xhr.withCredentials = true

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const filePct = (e.loaded / e.total) * (1 / totalFiles)
            setUploadProgress(Math.round((completedFiles / totalFiles + filePct) * 100))
          }
        }

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            completedFiles++
            setUploadProgress(Math.round((completedFiles / totalFiles) * 100))
            resolve()
          } else {
            try {
              const err = JSON.parse(xhr.responseText)
              reject(new Error(err.error?.message || 'Upload failed'))
            } catch {
              reject(new Error(`Upload failed: ${xhr.status}`))
            }
          }
        }

        xhr.onerror = () => reject(new Error('Network error during upload'))
        xhr.send(formData)
      })
    }

    setUploadFile(null)
    setUploadFiles([])
    if (fileInputRef.current) fileInputRef.current.value = ''
    const res = await api.listDocuments(tenantId, selectedKB.id)
    setDocs(res.documents || [])
    setKbs(prev => prev.map(k => k.id === selectedKB.id ? { ...k, document_count: res.documents?.length || 0 } : k))
    toast('success', 'Upload complete', `${totalFiles} file${totalFiles > 1 ? 's' : ''} uploaded and indexed.`)
    } catch (err) {
      toast('error', 'Upload failed', (err as any).message)
    } finally {
      setUploading(false)
      setUploadProgress(0)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) setUploadFile(file)
  }


  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Knowledge</h1>
          <p className="page-sub">Vector-searchable collections & entity-relationship graphs your agents can query</p>
        </div>
        <button className="btn btn-primary" onClick={() => tab === 'knowledge_bases' ? setShowCreate(true) : setShowCreateGraph(true)}>
          + Create {tab === 'knowledge_bases' ? 'Collection' : 'Graph'}
        </button>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', marginBottom: 20, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', width: 'fit-content' }}>
        {(['knowledge_bases', 'knowledge_graphs'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 20px', fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer',
            background: tab === t ? 'var(--green)' : 'var(--bg)',
            color: tab === t ? '#fff' : 'var(--text-muted)',
            transition: 'all 0.15s',
          }}>
            {t === 'knowledge_bases' ? '📚 Knowledge Bases' : '🕸️ Knowledge Graphs'}
          </button>
        ))}
      </div>

      {tab === 'knowledge_graphs' ? (
        /* ── Knowledge Graphs tab ─────────────────────────────────── */
        <div className="page-body">
          {graphs.length === 0 ? (
            <div className="card empty-state">
              <span className="empty-icon">🕸️</span>
              <h2 className="empty-title">Map relationships between entities</h2>
              <p className="empty-desc">
                A knowledge graph stores entities (people, products, locations) and the relationships between them (works_at, sold_by, located_in). Agents use graph traversal for rich contextual reasoning.
              </p>
              <button className="btn btn-primary btn-lg" onClick={() => setShowCreateGraph(true)}>+ Create your first knowledge graph</button>
              <div style={{ marginTop: 24, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.8 }}>
                <div>🔗 Powered by Neo4j — auto-provisioned in Settings</div>
                <div>🤖 Agents traverse relationships during task execution</div>
                <div>📊 Entities extracted automatically from ingested documents</div>
              </div>
            </div>
          ) : selectedGraph ? (
            <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 24 }}>
              {/* Graph list sidebar */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Graphs</span>
                  <button onClick={() => setShowCreateGraph(true)} style={{
                    background: 'var(--purple, #8b5cf6)', color: '#fff', border: 'none', borderRadius: 6,
                    width: 28, height: 28, fontSize: 16, fontWeight: 700, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }} title="Create new graph">+</button>
                </div>
                {graphs.map(g => (
                  <button key={g.id} onClick={() => {
                    setSelectedGraph(g)
                    setGraphEntities([])
                    setAddEntityForm({ label: '', type: '' })
                    // Load existing entities from Neo4j
                    api.listGraphEntities(tenantId, g.id).then(res => {
                      setGraphEntities((res.entities || []).map((e: any) => ({ label: e.label, type: e.type })))
                    }).catch(() => {})
                  }} style={{
                    textAlign: 'left', padding: '12px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', width: '100%',
                    background: selectedGraph?.id === g.id ? 'var(--purple-bg, #f5f3ff)' : 'var(--bg-white)',
                    color: selectedGraph?.id === g.id ? 'var(--purple-dark, #6d28d9)' : 'var(--text-sub)',
                    fontWeight: selectedGraph?.id === g.id ? 700 : 500,
                    boxShadow: 'var(--shadow)', borderLeft: selectedGraph?.id === g.id ? '4px solid var(--purple, #8b5cf6)' : '4px solid transparent',
                    transition: 'all 0.1s'
                  }}>
                    <div style={{ fontSize: 14, marginBottom: 4 }}>{g.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {g.graph_kind} · {g.entity_count || 0} entities · {g.relationship_count || 0} relationships
                    </div>
                  </button>
                ))}
              </div>

              {/* Graph detail */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div className="card" style={{ padding: 24 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>{selectedGraph.name}</h2>
                      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>{selectedGraph.description || 'No description'}</p>
                      <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                        <span>🔗 {selectedGraph.graph_kind}</span>
                        <span>📍 {selectedGraph.host}:{selectedGraph.bolt_port}</span>
                        <span>📦 {selectedGraph.database_name}</span>
                        <span className="badge badge-active" style={{ fontSize: 10 }}>{selectedGraph.status}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-primary btn-sm" onClick={async () => {
                        setShowDBImport(true)
                        setSchemaLoading(true)
                        setDbSchema(null)
                        setSelectedTables(new Set())
                        setImportResult(null)
                        setSelectedGraphDBConnection('internal')
                        try {
                          const [srcs, schema] = await Promise.all([
                            api.getDBSources(tenantId).then(r => r.sources || [r.data?.sources] || []).catch(() => []),
                            api.getGraphDBSchema(tenantId, selectedGraph.id),
                          ])
                          setDbSources(srcs)
                          setDbSchema(schema)
                          const all = new Set<string>()
                          for (const t of (schema.tables || [])) all.add(`${t.schema}.${t.name}`)
                          setSelectedTables(all)
                        } catch (err) { toast('error', 'Failed to scan database', (err as any).message) }
                          finally { setSchemaLoading(false) }
                      }}
                        style={{ padding: '4px 12px', fontSize: 12 }}>
                        🗄️ Import from Database
                      </button>
                      <button onClick={() => setSelectedGraph(null)} style={{
                        background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                        padding: '4px 12px', fontSize: 12, cursor: 'pointer', color: 'var(--text-muted)'
                      }}>← Back to list</button>
                      <button onClick={() => deleteGraph(selectedGraph.id, selectedGraph.name)} style={{
                        background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14, padding: 2
                      }} title="Delete graph">🗑</button>
                    </div>
                  </div>
                </div>

                {/* Entity stats & management */}
                <div className="card" style={{ padding: 24 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>
                      Entities ({selectedGraph.entity_count || 0}) · Relationships ({selectedGraph.relationship_count || 0})
                    </h3>
                  </div>

                  {graphEntities.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '32px 0' }}>
                      <div style={{ fontSize: 40, marginBottom: 8 }}>🏷️</div>
                      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
                        No entities added yet. Add entities manually below, or attach this graph to an agent — the agent will populate it during task execution.
                      </p>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                        <div className="form-group" style={{ margin: 0 }}>
                          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Label</label>
                          <input className="input" placeholder="e.g. Acme Corp" value={addEntityForm.label}
                            onChange={e => setAddEntityForm({ ...addEntityForm, label: e.target.value })}
                            style={{ fontSize: 13, padding: '6px 10px', width: 160 }} />
                        </div>
                        <div className="form-group" style={{ margin: 0 }}>
                          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Type</label>
                          <select className="input" value={addEntityForm.type}
                            onChange={e => setAddEntityForm({ ...addEntityForm, type: e.target.value })}
                            style={{ fontSize: 13, padding: '6px 10px', width: 140 }}>
                            <option value="">Select type…</option>
                            <option value="Person">Person</option>
                            <option value="Organization">Organization</option>
                            <option value="Product">Product</option>
                            <option value="Location">Location</option>
                            <option value="Document">Document</option>
                            <option value="Event">Event</option>
                            <option value="Concept">Concept</option>
                          </select>
                        </div>
                        <button className="btn btn-primary btn-sm" disabled={addingEntity || !addEntityForm.label.trim()}
                          onClick={async () => {
                            setAddingEntity(true)
                            try {
                              await api.addGraphEntity(tenantId, selectedGraph.id, {
                                label: addEntityForm.label,
                                type: addEntityForm.type || 'Entity',
                              })
                              setGraphEntities(prev => [...prev, { label: addEntityForm.label, type: addEntityForm.type || 'Entity' }])
                              setAddEntityForm({ label: '', type: '' })
                              toast('success', 'Entity added', `"${addEntityForm.label}" added to graph.`)
                              // Reload graphs to update counts
                              loadGraphs(tenantId)
                            } catch (err) { toast('error', 'Failed', (err as any).message) } finally { setAddingEntity(false) }
                          }}
                          style={{ padding: '6px 16px', fontSize: 12 }}>
                          + Add Entity
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {graphEntities.map((entity: any) => (
                        <div key={entity.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--bg)', borderRadius: 6 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 13, fontWeight: 600 }}>{entity.label}</span>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--border)', padding: '2px 6px', borderRadius: 4 }}>{entity.type}</span>
                          </div>
                          <button onClick={async () => {
                            try {
                              await api.deleteGraphEntity(tenantId, selectedGraph.id, entity.label)
                              setGraphEntities(prev => prev.filter(e => e.label !== entity.label))
                              loadGraphs(tenantId)
                              toast('success', 'Entity removed', `"${entity.label}" removed from graph.`)
                            } catch (err) { toast('error', 'Failed', (err as any).message) }
                          }} style={{
                            background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 12
                          }}>✕</button>
                        </div>
                      ))}
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-end' }}>
                        <div className="form-group" style={{ margin: 0 }}>
                          <input className="input" placeholder="Label" value={addEntityForm.label}
                            onChange={e => setAddEntityForm({ ...addEntityForm, label: e.target.value })}
                            style={{ fontSize: 12, padding: '5px 8px', width: 140 }} />
                        </div>
                        <select className="input" value={addEntityForm.type}
                          onChange={e => setAddEntityForm({ ...addEntityForm, type: e.target.value })}
                          style={{ fontSize: 12, padding: '5px 8px', width: 120, margin: 0 }}>
                          <option value="">Type…</option>
                          <option value="Person">Person</option>
                          <option value="Organization">Organization</option>
                          <option value="Product">Product</option>
                          <option value="Location">Location</option>
                          <option value="Document">Document</option>
                        </select>
                        <button className="btn btn-primary btn-sm" disabled={!addEntityForm.label.trim() || addingEntity}
                          onClick={async () => {
                            setAddingEntity(true)
                            try {
                              await api.addGraphEntity(tenantId, selectedGraph.id, {
                                label: addEntityForm.label,
                                type: addEntityForm.type || 'Entity',
                              })
                              setGraphEntities(prev => [...prev, { label: addEntityForm.label, type: addEntityForm.type || 'Entity' }])
                              setAddEntityForm({ label: '', type: '' })
                              loadGraphs(tenantId)
                              toast('success', 'Entity added', `"${addEntityForm.label}" added to graph.`)
                            } catch (err) { toast('error', 'Failed', (err as any).message) } finally { setAddingEntity(false) }
                          }}
                          style={{ padding: '5px 10px', fontSize: 11 }}>+</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Graph list (no selection) */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>All Graphs ({graphs.length})</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
                {graphs.map(g => (
                  <div key={g.id} onClick={() => setSelectedGraph(g)} className="card" style={{
                    padding: 20, borderLeft: '4px solid var(--purple, #8b5cf6)', cursor: 'pointer',
                    transition: 'transform 0.1s, box-shadow 0.1s',
                  }} onMouseOver={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--shadow-lg)' }}
                     onMouseOut={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = '' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{g.name}</h3>
                        {g.description && <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{g.description}</p>}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteGraph(g.id, g.name); }}
                        style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14, padding: 2 }}
                        title="Delete graph">🗑</button>
                    </div>
                    <div style={{ marginTop: 12, display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-muted)' }}>
                      <span><strong>{g.graph_kind}</strong></span>
                      <span>{g.host}:{g.bolt_port}</span>
                      <span>{g.entity_count || 0} entities</span>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <span className="badge badge-active" style={{ fontSize: 10 }}>{g.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Create Graph Modal */}
          {showCreateGraph && (
            <div className="modal-overlay">
              <div className="modal" style={{ maxWidth: 440 }}>
                <div className="modal-header">
                  <h2 className="modal-title">Create Knowledge Graph</h2>
                  <button onClick={() => setShowCreateGraph(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
                </div>
                <form onSubmit={createGraph}>
                  <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div className="form-group">
                      <label className="form-label">Graph Name *</label>
                      <input className="input" placeholder="e.g. Customer 360" value={graphForm.name} onChange={e => setGraphForm({ ...graphForm, name: e.target.value })} required />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Description</label>
                      <input className="input" placeholder="What entities and relationships does this graph capture?" value={graphForm.description} onChange={e => setGraphForm({ ...graphForm, description: e.target.value })} />
                    </div>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                      💡 Graphs use Neo4j running locally (provisioned in Settings → Knowledge Infrastructure). Each graph is a separate named database within the same Neo4j instance.
                    </p>
                  </div>
                  <div className="modal-footer">
                    <button type="button" className="btn btn-secondary" onClick={() => setShowCreateGraph(false)}>Cancel</button>
                    <button type="submit" className="btn btn-primary" disabled={creatingGraph}>
                      {creatingGraph ? 'Creating...' : 'Create Graph'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* DB Import Modal */}
          {showDBImport && (
            <div className="modal-overlay">
              <div className="modal" style={{ maxWidth: 560, maxHeight: '80vh', overflow: 'auto' }}>
                <div className="modal-header">
                  <h2 className="modal-title">🗄️ Import from Database → {selectedGraph?.name}</h2>
                  <button onClick={() => { setShowDBImport(false); setImportResult(null) }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
                </div>
                <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0 }}>
                    Each <strong>table</strong> becomes a node label in your graph. <strong>Foreign keys</strong> become relationships.
                    Select the tables you want to import below. Rows are limited to avoid overloading Neo4j.
                  </p>

                  {/* Database Connection Selector */}
                  {dbSources.length > 1 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <label style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>Database:</label>
                      <select
                        value={selectedGraphDBConnection}
                        onChange={async (e) => {
                          const connId = e.target.value
                          setSelectedGraphDBConnection(connId)
                          setSchemaLoading(true)
                          setDbSchema(null)
                          setImportResult(null)
                          try {
                            const schema = await api.getGraphDBSchema(tenantId, selectedGraph.id, connId === 'internal' ? undefined : connId)
                            setDbSchema(schema)
                            const all = new Set<string>()
                            for (const t of (schema.tables || [])) all.add(`${t.schema}.${t.name}`)
                            setSelectedTables(all)
                          } catch (err) { toast('error', 'Failed to scan database', (err as any).message) }
                            finally { setSchemaLoading(false) }
                        }}
                        style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12, background: 'var(--bg)' }}
                      >
                        {dbSources.map((s: any) => (
                          <option key={s.id} value={s.id}>{s.name}{s.type !== 'internal' ? ` (${s.host || s.type})` : ''}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {schemaLoading ? (
                    <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>🔍 Scanning database schema…</div>
                  ) : dbSchema && dbSchema.tables?.length > 0 ? (
                    <>
                      <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                        <button onClick={() => {
                          const all = new Set<string>()
                          for (const t of dbSchema.tables) all.add(`${t.schema}.${t.name}`)
                          setSelectedTables(all)
                        }} style={{ fontSize: 11, padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                          Select All ({dbSchema.totalTables})
                        </button>
                        <button onClick={() => setSelectedTables(new Set())} style={{ fontSize: 11, padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                          Clear
                        </button>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflow: 'auto' }}>
                        {/* Group by schema */}
                        {(() => {
                          const schemas = new Map<string, any[]>()
                          for (const t of dbSchema.tables) {
                            const s = t.schema || 'public'
                            if (!schemas.has(s)) schemas.set(s, [])
                            schemas.get(s)!.push(t)
                          }
                          return (
                            <>
                              {Array.from(schemas.entries()).map(([schemaName, tables]) => {
                                const schemaKeys = tables.map((t: any) => `${t.schema}.${t.name}`)
                                const allInSchemaChecked = schemaKeys.every(k => selectedTables.has(k))
                                const someInSchemaChecked = schemaKeys.some(k => selectedTables.has(k))
                                const schemaIndeterminate = someInSchemaChecked && !allInSchemaChecked
                                return (
                                  <div key={schemaName}>
                                    <label style={{
                                      display: 'flex', alignItems: 'center', gap: 10,
                                      padding: '8px 14px', cursor: 'pointer',
                                      background: 'var(--bg-secondary, #f9fafb)',
                                      borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 12,
                                    }}>
                                      <input type="checkbox"
                                        checked={allInSchemaChecked}
                                        ref={el => { if (el) el.indeterminate = schemaIndeterminate }}
                                        onChange={() => {
                                          const next = new Set(selectedTables)
                                          if (allInSchemaChecked) {
                                            for (const k of schemaKeys) next.delete(k)
                                          } else {
                                            for (const k of schemaKeys) next.add(k)
                                          }
                                          setSelectedTables(next)
                                        }}
                                        style={{ width: 16, height: 16 }} />
                                      <span style={{ flex: 1 }}>📁 {schemaName}</span>
                                      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>{tables.length} table{tables.length !== 1 ? 's' : ''}</span>
                                    </label>
                                    {tables.map((t: any) => {
                                      const key = `${t.schema}.${t.name}`
                                      const checked = selectedTables.has(key)
                                      return (
                                        <label key={key} style={{
                                          display: 'flex', alignItems: 'center', gap: 10,
                                          padding: '10px 14px 10px 30px', borderRadius: 0, cursor: 'pointer',
                                          background: checked ? 'var(--purple-bg, #f5f3ff)' : 'var(--bg)',
                                          border: checked ? '1px solid var(--purple, #8b5cf6)' : '1px solid var(--border)',
                                          borderTop: 0, transition: 'all 0.1s',
                                        }}>
                                          <input type="checkbox" checked={checked} onChange={() => {
                                            const next = new Set(selectedTables)
                                            checked ? next.delete(key) : next.add(key)
                                            setSelectedTables(next)
                                          }} style={{ width: 16, height: 16 }} />
                                          <div style={{ flex: 1 }}>
                                            <div style={{ fontWeight: 600, fontSize: 13 }}>{t.name}</div>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                                              {t.columns?.length} cols{t.foreignKeys?.length > 0 ? ` · ${t.foreignKeys.length} FK${t.foreignKeys.length !== 1 ? 's' : ''}` : ''}{t.rowCount > 0 ? ` · ≈${t.rowCount.toLocaleString()} rows` : (t.rowCount === 0 ? ' · 0 rows' : '')}
                                            </div>
                                          </div>
                                        </label>
                                      )
                                    })}
                                  </div>
                                )
                              })}
                            </>
                          )
                        })()}
                      </div>

                      <div className="form-group" style={{ marginTop: 8 }}>
                        <label className="form-label">Row limit per table</label>
                        <select className="input" value={importLimit} onChange={e => setImportLimit(parseInt(e.target.value))} style={{ width: 160 }}>
                          <option value={100}>100 rows</option>
                          <option value={500}>500 rows</option>
                          <option value={1000}>1,000 rows</option>
                          <option value={5000}>5,000 rows</option>
                          <option value={0}>All rows (no limit)</option>
                        </select>
                      </div>

                      {importResult && (
                        <div style={{
                          padding: 14, borderRadius: 8, marginTop: 4,
                          background: importResult.errors?.length ? '#fef3c7' : '#d1fae5',
                          border: `1px solid ${importResult.errors?.length ? '#f59e0b' : '#10b981'}`,
                        }}>
                          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                            {importResult.errors?.length ? '⚠️ Import completed with warnings' : '✅ Import successful'}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                            {importResult.tables} tables · {importResult.nodes} nodes · {importResult.relationships} relationships
                          </div>
                          {importResult.errors?.length > 0 && (
                            <div style={{ marginTop: 8, fontSize: 11, color: '#92400e' }}>
                              {importResult.errors.slice(0, 3).map((e: string, i: number) => (
                                <div key={i}>⚠ {e}</div>
                              ))}
                              {importResult.errors.length > 3 && <div>…and {importResult.errors.length - 3} more</div>}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  ) : !schemaLoading && dbSchema ? (
                    <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>
                      No tables found in the database. Make sure migrations have been run.
                    </div>
                  ) : null}
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-secondary" onClick={() => { setShowDBImport(false); setImportResult(null) }}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn-primary" disabled={importing || selectedTables.size === 0 || schemaLoading}
                    onClick={async () => {
                      setImporting(true)
                      setImportResult(null)
                      try {
                        const res = await api.importGraphFromDB(tenantId, selectedGraph.id, {
                          tables: Array.from(selectedTables),
                          limit: importLimit,
                          connectionId: selectedGraphDBConnection === 'internal' ? undefined : selectedGraphDBConnection,
                        })
                        setImportResult(res)
                        if (!res.errors?.length) {
                          toast('success', 'Import complete', `${res.nodes} nodes, ${res.relationships} relationships imported.`)
                          // Reload graph to update counts
                          loadGraphs(tenantId)
                        }
                      } catch (err: any) { toast('error', 'Import failed', err.message) }
                        finally { setImporting(false) }
                    }}
                  >
                    {importing ? '⟳ Importing…' : `Import ${selectedTables.size} table${selectedTables.size !== 1 ? 's' : ''}`}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* ── Knowledge Bases tab (existing content) ───────────────── */
        <>
      <div className="page-body">
        {loading ? (
          <div className="skeleton" style={{ height: 350 }} />
        ) : kbs.length === 0 ? (
          <div className="card empty-state">
            <span className="empty-icon">📚</span>
            <h2 className="empty-title">Give your agents context</h2>
            <p className="empty-desc">
              A knowledge base is a searchable collection of documents. Agents will pull relevant chunks
              (grounded in your own data) whenever they need to answer questions.
            </p>
            <button className="btn btn-primary btn-lg" onClick={() => setShowCreate(true)}>+ Create your first knowledge base</button>
            <div style={{ marginTop: 32, fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 20, justifyContent: 'center', flexWrap: 'wrap' }}>
              <span>💡 Great for policies, playbooks, product docs</span>
              <span>·</span>
              <span>📄 Supports PDF, DOCX, XLSX, TXT, MD, CSV</span>
            </div>
          </div>
        ) : (
          <div className="grid-2col" style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 24 }}>
            {/* Left side list of collections */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Knowledge Bases</span>
                <button onClick={() => setShowCreate(true)} style={{
                  background: 'var(--green)', color: '#fff', border: 'none', borderRadius: 6,
                  width: 28, height: 28, fontSize: 16, fontWeight: 700, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }} title="Create new knowledge base">+</button>
              </div>
              {kbs.map(k => (
                <div key={k.id} style={{ position: 'relative' }}>
                  <button onClick={() => selectKB(tenantId, k)} style={{
                    textAlign: 'left', padding: '14px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', width: '100%',
                    background: selectedKB?.id === k.id ? 'var(--green-bg)' : 'var(--bg-white)',
                    color: selectedKB?.id === k.id ? 'var(--green-dark)' : 'var(--text-sub)',
                    fontWeight: selectedKB?.id === k.id ? 700 : 500,
                    boxShadow: 'var(--shadow)', borderLeft: selectedKB?.id === k.id ? '4px solid var(--green)' : '4px solid transparent',
                    transition: 'all 0.1s'
                  }}>
                    <div style={{ fontSize: 14, marginBottom: 4 }}>{k.name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>📄 {k.document_count || 0} docs</span>
                    </div>
                  </button>
                  <button onClick={async (e) => {
                    e.stopPropagation()
                    const ok = await confirm({
                      title: 'Delete Knowledge Base',
                      description: `Delete "${k.name}" and all its documents? This cannot be undone.`,
                      confirmLabel: 'Delete',
                      variant: 'danger',
                    })
                    if (!ok) return
                    try {
                      await api.deleteKB(tenantId, k.id)
                      setKbs(prev => prev.filter(kb => kb.id !== k.id))
                      if (selectedKB?.id === k.id) setSelectedKB(null)
                      toast('success', 'Deleted', `"${k.name}" removed.`)
                    } catch (err) { toast('error', 'Delete failed', (err as any).message) }
                  }} style={{
                    position: 'absolute', top: 8, right: 8, background: 'none', border: 'none',
                    color: '#ef4444', cursor: 'pointer', fontSize: 12, padding: 2, opacity: 0.5,
                  }} title="Delete knowledge base" onMouseOver={e => e.currentTarget.style.opacity = '1'} onMouseOut={e => e.currentTarget.style.opacity = selectedKB?.id === k.id ? '0.7' : '0.5'}>
                    🗑
                  </button>
                </div>
              ))}
            </div>

            {/* Right side content */}
            {selectedKB && (
              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 24 }}>
                {/* Documents list */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                  <div className="card" style={{ padding: 24 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                      <div>
                        <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>{selectedKB.name}</h2>
                        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>{selectedKB.description || 'No description'}</p>
                        <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                          <span>📄 {docs.length} docs</span>
                          <span>✅ {docs.filter((d: any) => d.status === 'INDEXED').length} indexed</span>
                          {docs.filter((d: any) => d.status === 'PROCESSING').length > 0 && <span style={{ color: '#f59e0b' }}>⏳ {docs.filter((d: any) => d.status === 'PROCESSING').length} processing</span>}
                          {docs.filter((d: any) => d.status === 'FAILED' || d.status === 'PARTIALLY_INDEXED').length > 0 && <span style={{ color: '#ef4444' }}>⚠️ {docs.filter((d: any) => d.status === 'FAILED' || d.status === 'PARTIALLY_INDEXED').length} need attention</span>}
                        </div>
                      </div>
                      {docs.filter((d: any) => d.status === 'FAILED' || d.status === 'PARTIALLY_INDEXED').length > 0 && (
                        <button className="btn btn-sm" onClick={async () => {
                          try {
                            const res = await api.reprocessKB(tenantId, selectedKB.id)
                            toast('success', 'Reprocessing started', res.message || `${res.reprocessed} documents queued`)
                            // Refresh after a short delay
                            setTimeout(() => selectKB(tenantId, selectedKB), 2000)
                          } catch (err) { toast('error', 'Reprocess failed', (err as any).message) }
                        }} style={{
                          background: 'var(--green)', color: '#fff', border: 'none', borderRadius: 6,
                          padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        }}>🔄 Reprocess All</button>
                      )}
                      <button className="btn btn-sm" onClick={async () => {
                        setShowKBDBImport(true)
                        setKbImportResult(null)
                        setKbSelectedTables(new Set())
                        setKbSchemaLoading(true)
                        setSelectedKBDBConnection('internal')
                        try {
                          const [srcs, res] = await Promise.all([
                            api.getDBSources(tenantId).then(r => (r && (r.sources || r.data?.sources)) || []).catch(() => []),
                            api.getKBDBSchema(tenantId, selectedKB.id),
                          ])
                          setDbSources(srcs)
                          if (res && res.tables) {
                            setKbDBSchema(res)
                            setKbSelectedTables(new Set((res.tables || []).map((t: any) => `${t.schema}.${t.name}`)))
                          }
                        } catch (err) { toast('error', 'Failed to scan schema', (err as any).message) }
                        finally { setKbSchemaLoading(false) }
                      }} style={{
                        background: 'var(--purple)', color: '#fff', border: 'none', borderRadius: 6,
                        padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      }}>🗄️ Import from Database</button>
                    </div>

                    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
                      <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Documents ({docs.length})</h3>
                      {docs.length === 0 ? (
                        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No documents added to this collection yet.</p>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {docs.map(doc => {
                            const statusColor = doc.status === 'INDEXED' ? 'var(--green)'
                              : doc.status === 'PROCESSING' ? '#f59e0b'
                              : doc.status === 'PARTIALLY_INDEXED' ? '#f97316'
                              : '#ef4444'
                            const statusIcon = doc.status === 'INDEXED' ? '✅'
                              : doc.status === 'PROCESSING' ? '⏳'
                              : doc.status === 'PARTIALLY_INDEXED' ? '⚠️'
                              : '❌'
                            return (
                            <div key={doc.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--bg)', borderRadius: 6 }}>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title || doc.name}</span>
                                  <span className="badge" style={{
                                    fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 99,
                                    background: statusColor + '18', color: statusColor, border: `1px solid ${statusColor}40`
                                  }}>{statusIcon} {doc.status}</span>
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                                  {doc.indexed_chunk_count != null ? `${doc.indexed_chunk_count}/${doc.chunk_count || 0} chunks indexed` : `${doc.chunk_count || 0} chunks`}
                                </div>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                {(doc.status === 'FAILED' || doc.status === 'PARTIALLY_INDEXED') && (
                                  <button
                                    onClick={async () => {
                                      try {
                                        await api.reprocessDocument(tenantId, selectedKB.id, doc.id)
                                        toast('success', 'Reprocessing', `"${doc.title || doc.name}" queued for reprocessing`)
                                        setTimeout(() => selectKB(tenantId, selectedKB), 2000)
                                      } catch (err) { toast('error', 'Reprocess failed', (err as any).message) }
                                    }}
                                    style={{
                                      background: 'none', border: 'none', cursor: 'pointer',
                                      color: 'var(--green)', fontSize: 13, padding: '2px 6px', borderRadius: 4,
                                      transition: 'background 0.15s',
                                    }}
                                    title="Reprocess document"
                                    onMouseOver={e => (e.currentTarget.style.background = 'var(--green-bg)')}
                                    onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
                                  >🔄</button>
                                )}
                                <button
                                  onClick={async () => {
                                    const ok = await confirm({
                                      title: 'Delete Document',
                                      description: `Are you sure you want to delete "${doc.title || doc.name}"? This will remove it from the vector index.`,
                                      confirmLabel: 'Delete',
                                      variant: 'danger',
                                    })
                                    if (!ok) return
                                    try {
                                      await api.deleteDocument(tenantId, selectedKB.id, doc.id)
                                      setDocs(prev => prev.filter(d => d.id !== doc.id))
                                      setKbs(prev => prev.map(k => k.id === selectedKB.id ? { ...k, document_count: (k.document_count || 1) - 1 } : k))
                                      toast('success', 'Document deleted', `"${doc.title || doc.name}" removed from the collection.`)
                                    } catch (err) {
                                      toast('error', 'Delete failed', (err as any).message)
                                    }
                                  }}
                                  style={{
                                    background: 'none', border: 'none', cursor: 'pointer',
                                    color: '#ef4444', fontSize: 14, padding: '2px 6px', borderRadius: 4,
                                    transition: 'background 0.15s',
                                  }}
                                  title="Delete document"
                                  onMouseOver={e => (e.currentTarget.style.background = '#fef2f2')}
                                  onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
                                >
                                  🗑
                                </button>
                              </div>
                            </div>
                          )})}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Tabbed Ingest Panel */}
                  <div className="card" style={{ padding: 24 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <h3 style={{ fontSize: 15, fontWeight: 800 }}>Ingest Document</h3>
                      <div style={{ display: 'flex', background: 'var(--bg)', borderRadius: 8, padding: 2, border: '1px solid var(--border)', gap: 2 }}>
                        {(['upload', 'paste'] as const).map(tab => (
                          <button key={tab} type="button"
                            onClick={() => setIngestTab(tab)}
                            style={{
                              padding: '5px 14px', fontSize: 12, fontWeight: 700,
                              background: ingestTab === tab ? 'var(--green)' : 'transparent',
                              color: ingestTab === tab ? '#fff' : 'var(--text-muted)',
                              border: 'none', borderRadius: 6, cursor: 'pointer', transition: 'all 0.15s'
                            }}>
                            {tab === 'upload' ? '📁 Upload File' : '📋 Paste Text'}
                          </button>
                        ))}
                      </div>
                    </div>

                    {ingestTab === 'upload' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        {/* Drag & Drop Zone */}
                        <div
                          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                          onDragLeave={() => setDragOver(false)}
                          onDrop={handleDrop}
                          onClick={() => fileInputRef.current?.click()}
                          style={{
                            border: `2px dashed ${dragOver ? 'var(--green)' : 'var(--border-dark)'}`,
                            borderRadius: 10,
                            padding: '32px 24px',
                            textAlign: 'center',
                            cursor: 'pointer',
                            background: dragOver ? 'var(--green-bg)' : 'var(--bg)',
                            transition: 'all 0.15s',
                          }}>
                          <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
                          {uploadFiles.length > 0 || uploadFile ? (
                            <div>
                              {uploadFiles.length > 1 ? (
                                <>
                                  <div style={{ fontWeight: 700, fontSize: 14 }}>{uploadFiles.length} files selected</div>
                                  <ul style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, paddingLeft: 16, textAlign: 'left' }}>
                                    {uploadFiles.map((f, i) => (
                                      <li key={i}>{f.name} ({(f.size / 1024).toFixed(1)} KB)</li>
                                    ))}
                                  </ul>
                                </>
                              ) : (
                                <>
                                  <div style={{ fontWeight: 700, fontSize: 14 }}>{(uploadFile || uploadFiles[0])?.name}</div>
                                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{((uploadFile || uploadFiles[0])?.size / 1024).toFixed(1)} KB</div>
                                </>
                              )}
                            </div>
                          ) : (
                            <>
                              <div style={{ fontWeight: 600, fontSize: 14 }}>Drop files here or click to browse</div>
                              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Supports PDF, DOCX, XLSX, TXT, MD, CSV — up to 50MB each, multiple files allowed</div>
                            </>
                          )}
                        </div>
                        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }}
                          accept=".pdf,.docx,.doc,.xlsx,.xls,.txt,.md,.csv"
                          onChange={e => {
                            const files = e.target.files
                            if (files && files.length > 0) {
                              setUploadFiles(Array.from(files))
                              setUploadFile(files[0])
                            }
                          }} />

                        {/* Progress bar */}
                        {uploading && (
                          <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6, color: 'var(--text-muted)' }}>
                              <span style={{ fontWeight: 600 }}>
                                {uploadProgress < 30 && '📤 Preparing…'}
                                {uploadProgress >= 30 && uploadProgress < 90 && '⬆ Uploading file…'}
                                {uploadProgress >= 90 && uploadProgress < 100 && '⚙️ Processing & extracting text…'}
                                {uploadProgress === 100 && '🧠 Indexing (creating embeddings)…'}
                              </span>
                              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{uploadProgress}%</span>
                            </div>
                            <div style={{ height: 6, background: 'var(--border)', borderRadius: 99, overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${uploadProgress}%`, background: 'var(--green)', borderRadius: 99, transition: 'width 0.3s ease' }} />
                            </div>
                          </div>
                        )}

                        <button className="btn btn-primary btn-sm" type="button"
                          disabled={(uploadFiles.length === 0 && !uploadFile) || uploading} onClick={uploadDocument}
                          style={{ alignSelf: 'flex-start' }}>
                          {uploading ? `Uploading ${uploadFiles.length > 1 ? `${uploadFiles.length} files` : 'file'}…` : uploadFiles.length > 1 ? `⬆ Upload ${uploadFiles.length} Files` : '⬆ Upload & Vectorise'}
                        </button>
                      </div>
                    ) : (
                      <form onSubmit={addDocument} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div className="form-group">
                          <input className="input" placeholder="Document Title (e.g. Acme Privacy Policy)"
                            value={docForm.title} onChange={e => setDocForm({ ...docForm, title: e.target.value })} required />
                        </div>
                        <div className="form-group">
                          <textarea className="input" rows={6}
                            placeholder="Paste document content to slice and index in vector store..."
                            value={docForm.content} onChange={e => setDocForm({ ...docForm, content: e.target.value })} required />
                        </div>
                        <button className="btn btn-primary btn-sm" type="submit" disabled={addingDoc} style={{ alignSelf: 'flex-start' }}>
                          {addingDoc ? 'Indexing...' : '✓ Ingest & Vectorise'}
                        </button>
                      </form>
                    )}
                  </div>
                </div>


                {/* Semantic Query Testing */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <div className="card" style={{ padding: 24 }}>
                    <h3 style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>🔌 Semantic Query Tool</h3>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
                      Search your indexed documents using vector similarity. Results auto-update as you type.
                    </p>

                    {/* Search input with loading indicator */}
                    <div style={{ position: 'relative', marginBottom: 12 }}>
                      <input
                        className="input"
                        placeholder={!selectedKB ? 'Select a knowledge base first…' : 'Type to search (e.g. termination timeline)…'}
                        value={query}
                        onChange={e => { setQuery(e.target.value); debouncedSearch(e.target.value) }}
                        disabled={!selectedKB}
                        style={{ paddingRight: searching ? 36 : 12 }}
                      />
                      {searching && (
                        <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 14, animation: 'spin 1s linear infinite' }}>
                          ⏳
                        </span>
                      )}
                    </div>

                    {/* Tuning controls */}
                    <div style={{ display: 'flex', gap: 16, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>Top K</label>
                        <select
                          value={searchTopK}
                          onChange={e => { setSearchTopK(Number(e.target.value)); if (query.trim()) debouncedSearch(query) }}
                          style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12, background: 'var(--bg)' }}
                        >
                          {[1,3,5,10,20].map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>Min Score</label>
                        <select
                          value={searchThreshold}
                          onChange={e => { setSearchThreshold(Number(e.target.value)); if (query.trim()) debouncedSearch(query) }}
                          style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12, background: 'var(--bg)' }}
                        >
                          {[0.3,0.4,0.45,0.5,0.6,0.7].map(v => <option key={v} value={v}>{Math.round(v*100)}%</option>)}
                        </select>
                      </div>
                      {query && results.length > 0 && (
                        <button className="btn btn-secondary btn-sm" type="button"
                          onClick={() => { setResults([]); setQuery(''); setHasSearched(false); setExpandedResults(new Set()) }}
                          style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 10px' }}>
                          ✕ Clear
                        </button>
                      )}
                    </div>

                    {/* Results */}
                    {results.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase' }}>
                            🎯 {results.length} match{results.length !== 1 ? 'es' : ''}
                          </span>
                          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                            Top {searchTopK} · Min {Math.round(searchThreshold*100)}% similarity
                          </span>
                        </div>
                        {results.map((res, idx) => {
                          const scorePct = ((res.score ?? res.similarity) * 100).toFixed(1)
                          const scoreColor = parseFloat(scorePct) >= 55 ? 'var(--green)' : parseFloat(scorePct) >= 45 ? '#f59e0b' : '#ef4444'
                          const isExpanded = expandedResults.has(idx)
                          const contentSnippet = res.content?.length > 200 && !isExpanded
                            ? res.content.slice(0, 200) + '…'
                            : res.content
                          return (
                          <div key={idx} style={{
                            background: 'var(--bg-white)',
                            border: '1px solid var(--border)',
                            borderRadius: 8,
                            overflow: 'hidden',
                            transition: 'box-shadow 0.15s',
                          }}>
                            {/* Header bar */}
                            <div style={{
                              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              padding: '8px 14px',
                              background: 'var(--bg)',
                              borderBottom: '1px solid var(--border)',
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{
                                  fontSize: 12, fontWeight: 800,
                                  color: scoreColor,
                                  background: `${scoreColor}14`,
                                  padding: '2px 8px', borderRadius: 99,
                                }}>
                                  {scorePct}%
                                </span>
                                {/* Score bar */}
                                <div style={{ width: 60, height: 4, background: 'var(--border)', borderRadius: 99, overflow: 'hidden' }}>
                                  <div style={{ width: `${Math.min(parseFloat(scorePct), 100)}%`, height: '100%', background: scoreColor, borderRadius: 99 }} />
                                </div>
                                {res.documentName && (
                                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>
                                    📄 {res.documentName}
                                  </span>
                                )}
                              </div>
                              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>#{idx + 1}</span>
                            </div>
                            {/* Content */}
                            <div style={{ padding: '10px 14px' }}>
                              <p style={{
                                fontSize: 12, lineHeight: 1.6, color: 'var(--text)',
                                margin: 0,
                                whiteSpace: isExpanded ? 'pre-wrap' : 'normal',
                                wordBreak: 'break-word',
                              }}>
                                {contentSnippet}
                              </p>
                              {res.content?.length > 200 && (
                                <button
                                  onClick={() => {
                                    const next = new Set(expandedResults)
                                    isExpanded ? next.delete(idx) : next.add(idx)
                                    setExpandedResults(next)
                                  }}
                                  style={{
                                    background: 'none', border: 'none', color: 'var(--green)',
                                    fontSize: 11, fontWeight: 600, cursor: 'pointer',
                                    padding: '4px 0 0 0',
                                  }}>
                                  {isExpanded ? '▲ Show less' : '▼ Show more'}
                                </button>
                              )}
                            </div>
                          </div>
                        )})}
                      </div>
                    ) : hasSearched && !searching ? (
                      <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                        ⚠️ No results found. Try lowering the minimum score or checking that documents are indexed.
                      </div>
                    ) : query && !searching && !hasSearched ? (
                      <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                        🔍 Type to start searching…
                      </div>
                    ) : !query && !selectedKB ? (
                      <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                        👆 Select a knowledge base and start typing to search.
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* KB DB Import Modal */}
      {showKBDBImport && selectedKB && (
        <div className="modal-overlay" onClick={() => setShowKBDBImport(false)}>
          <div className="modal" style={{ maxWidth: 600, maxHeight: '85vh', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">🗄️ Import from Database → {selectedKB.name}</h2>
              <button onClick={() => setShowKBDBImport(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Each selected table's rows are formatted as text documents and fed into the <strong>chunk → embed → vector index</strong> pipeline,
                making them searchable via the Knowledge Base. Large tables are split into batches of <strong>{kbRowsPerDoc} rows</strong> per document.
              </p>

              {/* Database Connection Selector */}
              {dbSources.length > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>Database:</label>
                  <select
                    value={selectedKBDBConnection}
                    onChange={async (e) => {
                      const connId = e.target.value
                      setSelectedKBDBConnection(connId)
                      setKbSchemaLoading(true)
                      setKbDBSchema(null)
                      setKbImportResult(null)
                      try {
                        const res = await api.getKBDBSchema(tenantId, selectedKB.id, connId === 'internal' ? undefined : connId)
                        if (res && res.tables) {
                          setKbDBSchema(res)
                          setKbSelectedTables(new Set((res.tables || []).map((t: any) => `${t.schema}.${t.name}`)))
                        }
                      } catch (err) { toast('error', 'Failed to scan database', (err as any).message) }
                        finally { setKbSchemaLoading(false) }
                    }}
                    style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12, background: 'var(--bg)' }}
                  >
                    {dbSources.map((s: any) => (
                      <option key={s.id} value={s.id}>{s.name}{s.type !== 'internal' ? ` (${s.host || s.type})` : ''}</option>
                    ))}
                  </select>
                </div>
              )}

              {kbImportResult ? (
                <div style={{
                  padding: 16, borderRadius: 8,
                  background: kbImportResult.errors?.length ? '#fef3c7' : '#ecfdf5',
                  border: `1px solid ${kbImportResult.errors?.length ? '#f59e0b' : 'var(--green)'}`,
                  maxHeight: 300, overflowY: 'auto'
                }}>
                  <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 14 }}>
                    {kbImportResult.errors?.length ? '⚠️ Import completed with warnings' : '✅ Import successful'}
                  </div>
                  <div style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div>📊 {kbImportResult.tables} tables processed</div>
                    <div>📄 {kbImportResult.documents} documents created</div>
                    <div>📝 {kbImportResult.totalRows} total rows imported</div>
                    {kbImportResult.errors?.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontWeight: 600, marginBottom: 4 }}>Errors:</div>
                        {kbImportResult.errors.map((e: string, i: number) => (
                          <div key={i} style={{ color: '#92400e', fontSize: 12, padding: '2px 0' }}>• {e}</div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                    {kbSchemaLoading ? (
                      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>🔍 Scanning PostgreSQL schema…</div>
                    ) : kbDBSchema ? (
                      (() => {
                        // Group tables by schema for schema-level selection
                        const schemas = new Map<string, any[]>()
                        for (const t of (kbDBSchema.tables || [])) {
                          const s = t.schema || 'public'
                          if (!schemas.has(s)) schemas.set(s, [])
                          schemas.get(s)!.push(t)
                        }
                        return (
                      <div>
                        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 12, fontSize: 11, background: 'var(--bg)' }}>
                          <button type="button" onClick={() => {
                            const allTables = (kbDBSchema.tables || []).map((t: any) => `${t.schema}.${t.name}`)
                            setKbSelectedTables(new Set(allTables))
                          }} style={{ color: 'var(--green)', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer' }}>Select All</button>
                          <span style={{ color: 'var(--border-dark)' }}>|</span>
                          <button type="button" onClick={() => setKbSelectedTables(new Set())}
                            style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>Clear</button>
                          <span style={{ flex: 1 }} />
                          <span style={{ color: 'var(--text-muted)' }}>{kbDBSchema.tables?.length || 0} tables in {schemas.size} schema{schemas.size !== 1 ? 's' : ''}</span>
                        </div>
                        {Array.from(schemas.entries()).map(([schemaName, tables]) => {
                          const schemaKeys = tables.map((t: any) => `${t.schema}.${t.name}`)
                          const allInSchemaChecked = schemaKeys.every(k => kbSelectedTables.has(k))
                          const someInSchemaChecked = schemaKeys.some(k => kbSelectedTables.has(k))
                          const schemaIndeterminate = someInSchemaChecked && !allInSchemaChecked
                          return (
                            <div key={schemaName}>
                              {/* Schema header with bulk checkbox */}
                              <label style={{
                                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px',
                                cursor: 'pointer', background: 'var(--bg-secondary, #f9fafb)',
                                borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 12,
                              }}>
                                <input type="checkbox"
                                  checked={allInSchemaChecked}
                                  ref={el => {
                                    if (el) el.indeterminate = schemaIndeterminate
                                  }}
                                  onChange={() => {
                                    const next = new Set(kbSelectedTables)
                                    if (allInSchemaChecked) {
                                      for (const k of schemaKeys) next.delete(k)
                                    } else {
                                      for (const k of schemaKeys) next.add(k)
                                    }
                                    setKbSelectedTables(next)
                                  }}
                                  style={{ width: 16, height: 16 }} />
                                <span style={{ flex: 1 }}>📁 {schemaName}</span>
                                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>{tables.length} table{tables.length !== 1 ? 's' : ''}</span>
                              </label>
                              {/* Individual tables */}
                              {tables.map((tbl: any) => {
                                const key = `${tbl.schema}.${tbl.name}`
                                const checked = kbSelectedTables.has(key)
                                return (
                                  <label key={key} style={{
                                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px 10px 32px',
                                    cursor: 'pointer', borderBottom: '1px solid var(--border)',
                                    background: checked ? 'var(--green-bg)' : 'transparent',
                                    transition: 'background 0.1s',
                                  }}>
                                    <input type="checkbox" checked={checked} onChange={() => {
                                      const next = new Set(kbSelectedTables)
                                      checked ? next.delete(key) : next.add(key)
                                      setKbSelectedTables(next)
                                    }} style={{ width: 16, height: 16 }} />
                                    <div style={{ flex: 1 }}>
                                      <div style={{ fontWeight: 700, fontSize: 13 }}>{tbl.name}</div>
                                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                        {tbl.columns?.length || 0} columns{tbl.foreignKeys?.length > 0 ? ` · ${tbl.foreignKeys.length} FK${tbl.foreignKeys.length !== 1 ? 's' : ''}` : ''}{tbl.rowCount != null ? ` · ~${tbl.rowCount} rows` : ''}
                                      </div>
                                    </div>
                                  </label>
                                )
                              })}
                            </div>
                          )
                        })}
                      </div>
                        )})()
                    ) : (
                      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
                        No schema data. Click the button below to rescan.
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 12 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: 'var(--text-muted)' }}>Row limit:</span>
                      <select value={kbImportLimit} onChange={e => setKbImportLimit(Number(e.target.value))}
                        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12 }}>
                        <option value={100}>100</option>
                        <option value={500}>500</option>
                        <option value={1000}>1000</option>
                        <option value={5000}>5000</option>
                        <option value={0}>All</option>
                      </select>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: 'var(--text-muted)' }}>Rows per doc:</span>
                      <select value={kbRowsPerDoc} onChange={e => setKbRowsPerDoc(Number(e.target.value))}
                        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12 }}>
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                        <option value={200}>200</option>
                        <option value={500}>500</option>
                      </select>
                    </label>
                  </div>
                </>
              )}
            </div>

            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowKBDBImport(false)} disabled={kbImporting}>Cancel</button>
              {!kbImportResult && (
                <button type="button" className="btn btn-primary" disabled={kbImporting || (kbDBSchema && kbSelectedTables.size === 0) || kbSchemaLoading}
                  onClick={async () => {
                    setKbImporting(true)
                    setKbImportResult(null)
                    try {
                      const res = await api.importKBFromDB(tenantId, selectedKB.id, {
                        tables: Array.from(kbSelectedTables),
                        limit: kbImportLimit || undefined,
                        rowsPerDoc: kbRowsPerDoc,
                        connectionId: selectedKBDBConnection === 'internal' ? undefined : selectedKBDBConnection,
                      })
                      setKbImportResult(res)
                      if (res.errors?.length) {
                        toast('warning', 'Import with warnings', `${res.tables} tables, ${res.documents} docs created, ${res.totalRows} rows.`)
                      } else {
                        toast('success', 'Import complete', `${res.documents} documents created from ${res.tables} tables (${res.totalRows} rows).`)
                      }
                      // Refresh KB docs
                      selectKB(tenantId, selectedKB)
                    } catch (err: any) { toast('error', 'Import failed', err.message) }
                      finally { setKbImporting(false) }
                  }}
                >
                  {kbImporting ? '⟳ Importing…' : `Import ${kbDBSchema ? kbSelectedTables.size : 0} table${kbSelectedTables.size !== 1 ? 's' : ''}`}
                </button>
              )}
              {kbImportResult && (
                <button type="button" className="btn btn-primary" onClick={() => { setShowKBDBImport(false); selectKB(tenantId, selectedKB) }}>
                  Done
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create KB Modal */}
      {showCreate && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 440 }}>
            <div className="modal-header">
              <h2 className="modal-title">Create Collection</h2>
              <button onClick={() => setShowCreate(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            <form onSubmit={createKB}>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="form-group">
                  <label className="form-label">Collection Name *</label>
                  <input className="input" placeholder="e.g. Legal Agreements" value={kbForm.name} onChange={e => setKbForm({ ...kbForm, name: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Description</label>
                  <input className="input" placeholder="Helpful summary of documentation scope" value={kbForm.description} onChange={e => setKbForm({ ...kbForm, description: e.target.value })} />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? 'Creating...' : 'Create Collection'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      </>
      )}
      {ConfirmDialog}
    </div>
  )
}
