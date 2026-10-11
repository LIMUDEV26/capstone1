import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

type RelayAttachment = {
  filename: string;
  content: string;
  contentType?: string;
  cid?: string;
};

type RelayPayload = {
  to: { email: string; name?: string };
  cc?: Array<{ email: string; name?: string }>;
  subject: string;
  html: string;
  text?: string;
  attachments?: RelayAttachment[];
};

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
  maxDuration: 30,
};

function secretsMatch(received: string, expected: string) {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function address(entry: { email: string; name?: string }) {
  return entry.name ? { address: entry.email, name: entry.name } : entry.email;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed.' });

  const relaySecret = String(process.env.MAIL_RELAY_SECRET || '');
  const authorization = String(req.headers.authorization || '');
  const suppliedSecret = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!relaySecret || !secretsMatch(suppliedSecret, relaySecret)) {
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }

  const payload = req.body as RelayPayload;
  if (!payload?.to?.email || !payload.subject || !payload.html) {
    return res.status(400).json({ success: false, message: 'Invalid email payload.' });
  }

  const smtpUser = String(process.env.SMTP_USERNAME || '');
  const smtpPassword = String(process.env.SMTP_PASSWORD || '').replace(/\s+/g, '');
  const fromEmail = String(process.env.SMTP_FROM_EMAIL || smtpUser);
  const fromName = String(process.env.SMTP_FROM_NAME || 'LLB Accountants');
  if (!smtpUser || !smtpPassword || !fromEmail) {
    return res.status(503).json({ success: false, message: 'Mail transport is not configured.' });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: String(process.env.SMTP_HOST || 'smtp.gmail.com'),
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      requireTLS: Number(process.env.SMTP_PORT || 587) !== 465,
      auth: { user: smtpUser, pass: smtpPassword },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    const result = await transporter.sendMail({
      from: { address: fromEmail, name: fromName },
      to: address(payload.to),
      cc: (payload.cc || []).map(address),
      subject: payload.subject,
      html: payload.html,
      text: payload.text || undefined,
      priority: 'high',
      headers: { 'Auto-Submitted': 'auto-generated' },
      attachments: (payload.attachments || []).map((item) => ({
        filename: item.filename,
        content: Buffer.from(item.content, 'base64'),
        contentType: item.contentType || undefined,
        cid: item.cid || undefined,
      })),
    });

    return res.status(200).json({ success: true, messageId: result.messageId });
  } catch (error) {
    console.error('Mail relay delivery failed:', error);
    return res.status(502).json({ success: false, message: 'Email delivery failed.' });
  }
}
