// apps/api/src/utils/email.js
import nodemailer from 'nodemailer'

let transporter = null

function getTransporter() {
  if (transporter) return transporter

  // If no SMTP host is configured, use a console-log fallback so dev works out of the box.
  if (!process.env.SMTP_HOST) {
    console.info('[email] SMTP_HOST not set — using console transport (emails will be logged, not sent)')
    transporter = {
      sendMail: async (msg) => {
        console.log('\n──── ✉️  EMAIL (console transport) ────')
        console.log(`To:      ${msg.to}`)
        console.log(`From:    ${msg.from}`)
        console.log(`Subject: ${msg.subject}`)
        console.log(`Body:    ${(msg.text || '').slice(0, 500)}`)
        console.log('────────────────────────────────────\n')
        return { messageId: `console-${Date.now()}` }
      },
    }
    return transporter
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
    ignoreTLS: process.env.NODE_ENV === 'development' && process.env.SMTP_SECURE !== 'true',
  })
  return transporter
}

export async function sendEmail({ to, subject, html, text }) {
  try {
    const t = getTransporter()
    await t.sendMail({
      from: process.env.SMTP_FROM || 'noreply@kuvalam.ai',
      to,
      subject,
      html,
      text: text || html?.replace(/<[^>]*>/g, ''),
    })
    return { sent: true }
  } catch (err) {
    // Log but don't throw — email failure shouldn't break the flow
    console.warn('[email] send failed:', err.message)
    return { sent: false, error: err.message }
  }
}
