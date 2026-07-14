'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/context'

export default function KnowledgePage() {
  const { tenantId, toast } = useApp()
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
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Search
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (tenantId) loadKBs(tenantId)
  }, [tenantId])

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
    } catch (err) { console.error(err) }
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
    } catch (err: any) { toast('error', 'Create failed', err.message) } finally { setCreating(false) }
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
    } catch (err: any) { toast('error', 'Upload failed', err.message) } finally { setAddingDoc(false) }
  }

  async function search(e: any) {
    e.preventDefault()
    if (!query.trim()) return
    setSearching(true)
    try {
      const res = await api.searchKB(tenantId, selectedKB.id, { query, limit: 3 })
      setResults(res.results || [])
    } catch (err: any) { toast('error', 'Search failed', err.message) } finally { setSearching(false) }
  }

  async function uploadDocument() {
    if (!uploadFile || !selectedKB) return
    // Client-side validation for size + type
    const MAX_BYTES = 50 * 1024 * 1024
    const allowed = ['.pdf', '.docx', '.txt', '.md', '.csv']
    const ext = '.' + (uploadFile.name.split('.').pop() || '').toLowerCase()
    if (!allowed.includes(ext)) {
      toast('error', 'Unsupported file type', `Only ${allowed.join(', ')} files are supported.`)
      return
    }
    if (uploadFile.size > MAX_BYTES) {
      toast('error', 'File too large', 'Maximum size is 50 MB. Try splitting the document.')
      return
    }
    setUploading(true)
    setUploadProgress(10)
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'
      const formData = new FormData()
      formData.append('file', uploadFile)
      formData.append('knowledgeBaseId', selectedKB.id)

      setUploadProgress(30)

      // Use XHR for progress tracking
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        // Backend route: POST /tenants/:tenantId/knowledge-bases/:kbId/documents/upload
        xhr.open('POST', `${API_BASE}/tenants/${tenantId}/knowledge-bases/${selectedKB.id}/documents/upload`)
        xhr.withCredentials = true // sends httpOnly cookie

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setUploadProgress(30 + Math.round((e.loaded / e.total) * 60))
          }
        }

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadProgress(100)
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

      setUploadFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      // Reload doc list
      const res = await api.listDocuments(tenantId, selectedKB.id)
      setDocs(res.documents || [])
      setKbs(prev => prev.map(k => k.id === selectedKB.id ? { ...k, document_count: res.documents?.length || 0 } : k))
    } catch (err: any) {
      toast('error', 'Upload failed', err.message)
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
          <p className="page-sub">Vector-searchable document collections your agents can query</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Create Collection</button>

      </div>

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
              <span>📄 Supports PDF, DOCX, TXT, MD, CSV</span>
            </div>
          </div>
        ) : (
          <div className="grid-2col" style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 24 }}>
            {/* Left side list of collections */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {kbs.map(k => (
                <button key={k.id} onClick={() => selectKB(tenantId, k)} style={{
                  textAlign: 'left', padding: '12px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  background: selectedKB?.id === k.id ? 'var(--green-bg)' : 'var(--bg-white)',
                  color: selectedKB?.id === k.id ? 'var(--green-dark)' : 'var(--text-sub)',
                  fontWeight: selectedKB?.id === k.id ? 700 : 500,
                  boxShadow: 'var(--shadow)', borderLeft: selectedKB?.id === k.id ? '4px solid var(--green)' : 'none',
                  transition: 'all 0.1s'
                }}>
                  <div style={{ fontSize: 14 }}>{k.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{k.document_count || 0} documents</div>
                </button>
              ))}
            </div>

            {/* Right side content */}
            {selectedKB && (
              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 24 }}>
                {/* Documents list */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                  <div className="card" style={{ padding: 24 }}>
                    <div style={{ marginBottom: 20 }}>
                      <h2 style={{ fontSize: 16, fontWeight: 800 }}>{selectedKB.name}</h2>
                      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>{selectedKB.description || 'No description'}</p>
                    </div>

                    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
                      <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Documents ({docs.length})</h3>
                      {docs.length === 0 ? (
                        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No documents added to this collection yet.</p>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {docs.map(doc => (
                            <div key={doc.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--bg)', borderRadius: 6 }}>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title}</div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{doc.chunk_count || 0} chunks index</div>
                              </div>
                              <span className="badge badge-active" style={{ fontSize: 10 }}>Indexed</span>
                            </div>
                          ))}
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
                          {uploadFile ? (
                            <>
                              <div style={{ fontWeight: 700, fontSize: 14 }}>{uploadFile.name}</div>
                              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{(uploadFile.size / 1024).toFixed(1)} KB</div>
                            </>
                          ) : (
                            <>
                              <div style={{ fontWeight: 600, fontSize: 14 }}>Drop file here or click to browse</div>
                              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Supports PDF, DOCX, TXT, MD — up to 50MB</div>
                            </>
                          )}
                        </div>
                        <input ref={fileInputRef} type="file" style={{ display: 'none' }}
                          accept=".pdf,.docx,.txt,.md,.csv"
                          onChange={e => e.target.files?.[0] && setUploadFile(e.target.files[0])} />

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
                          disabled={!uploadFile || uploading} onClick={uploadDocument}
                          style={{ alignSelf: 'flex-start' }}>
                          {uploading ? 'Please wait…' : '⬆ Upload & Vectorise'}
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
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>Test embedding generation and cosine similarity lookup directly.</p>

                    <form onSubmit={search} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                      <input className="input" placeholder="Type query (e.g. termination timeline)..." value={query} onChange={e => setQuery(e.target.value)} required />
                      <button className="btn btn-primary btn-sm" type="submit" disabled={searching}>
                        {searching ? '🔍' : 'Search'}
                      </button>
                    </form>

                    {results.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase' }}>Retrieved Matches</div>
                        {results.map((res, idx) => (
                          <div key={idx} style={{ background: 'var(--bg)', borderRadius: 6, padding: 12, borderLeft: '3px solid var(--green)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                              <span>Match Score: <strong>{(res.similarity * 100).toFixed(1)}%</strong></span>
                            </div>
                            <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text)' }}>&ldquo;{res.content}&rdquo;</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

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
    </div>
  )
}
