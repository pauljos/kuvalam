// apps/api/src/services/storage.service.js
// Phase 3: Unified storage abstraction — S3 in production, local filesystem in dev
import { writeFile, readFile, mkdir, unlink } from 'fs/promises'
import { join, dirname } from 'path'

// Lazy-loaded S3 client (only instantiated if AWS credentials exist)
let s3Client = null
let S3_BUCKET = null

function getS3Client() {
  if (s3Client) return s3Client
  // Dynamic import to avoid errors when AWS SDK is not configured
  return null
}

async function initS3() {
  if (s3Client) return true
  if (!process.env.AWS_S3_BUCKET) return false

  try {
    const { S3Client } = await import('@aws-sdk/client-s3')
    S3_BUCKET = process.env.AWS_S3_BUCKET
    s3Client = new S3Client({
      region: process.env.AWS_REGION || 'eu-west-1',
      // Credentials auto-resolve from env/IAM role
    })
    console.log(`[Storage] S3 configured — bucket: ${S3_BUCKET}`)
    return true
  } catch (err) {
    console.warn('[Storage] S3 init failed, falling back to local:', err.message)
    return false
  }
}

// ─── Upload ────────────────────────────────────────────────────────────────

export async function uploadFile(key, buffer, contentType = 'application/octet-stream') {
  const useS3 = await initS3()

  if (useS3 && s3Client) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `documents/${key}`,
      Body: buffer,
      ContentType: contentType,
      ServerSideEncryption: 'AES256'
    }))
    console.log(`[Storage] S3 upload: documents/${key} (${buffer.length} bytes)`)
    return { provider: 's3', key: `documents/${key}`, bucket: S3_BUCKET }
  }

  // Local fallback
  const localPath = join(process.env.STORAGE_PATH || './uploads', key)
  await mkdir(dirname(localPath), { recursive: true })
  await writeFile(localPath, buffer)
  console.log(`[Storage] Local upload: ${localPath} (${buffer.length} bytes)`)
  return { provider: 'local', path: localPath }
}

// ─── Download ──────────────────────────────────────────────────────────────

export async function downloadFile(key) {
  const useS3 = await initS3()

  if (useS3 && s3Client) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3')
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: `documents/${key}`
    }))
    const chunks = []
    for await (const chunk of response.Body) {
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  // Local fallback
  const localPath = join(process.env.STORAGE_PATH || './uploads', key)
  return readFile(localPath)
}

// ─── Delete ────────────────────────────────────────────────────────────────

export async function deleteFile(key) {
  const useS3 = await initS3()

  if (useS3 && s3Client) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    await s3Client.send(new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: `documents/${key}`
    }))
    return true
  }

  // Local fallback
  const localPath = join(process.env.STORAGE_PATH || './uploads', key)
  try {
    await unlink(localPath)
  } catch { /* file may not exist */ }
  return true
}

// ─── Pre-signed URL (S3 only) ──────────────────────────────────────────────

export async function getSignedUrl(key, expiresIn = 3600) {
  const useS3 = await initS3()

  if (useS3 && s3Client) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3')
    const { getSignedUrl: awsGetSignedUrl } = await import('@aws-sdk/s3-request-presigner')
    const url = await awsGetSignedUrl(s3Client, new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: `documents/${key}`
    }), { expiresIn })
    return url
  }

  // Local: return a local path reference
  return `/api/v1/files/${encodeURIComponent(key)}`
}
