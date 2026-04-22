/**
 * Account security email delivery helpers.
 *
 * Resend API reference:
 * https://resend.com/docs/api-reference/
 * https://resend.com/docs/api-reference/emails
 */

import { sha256Hex } from '@yucp/shared';

const RESEND_BASE_URL = 'https://api.resend.com';
const RESEND_REQUEST_TIMEOUT_MS = 10_000;

type EmailOtpType = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getEmailOtpCopy(type: EmailOtpType): { subject: string; title: string; body: string } {
  switch (type) {
    case 'email-verification':
      return {
        subject: 'Verify your email',
        title: 'Verify your email',
        body: 'Enter this code to verify your email address.',
      };
    case 'forget-password':
      return {
        subject: 'Your recovery code',
        title: 'Account recovery code',
        body: 'Enter this code to continue recovering your account.',
      };
    case 'change-email':
      return {
        subject: 'Confirm your new recovery email',
        title: 'Confirm your recovery email',
        body: 'Enter this code to verify your recovery email address.',
      };
    default:
      return {
        subject: 'Your sign-in code',
        title: 'Sign-in code',
        body: 'Enter this code to continue signing in.',
      };
  }
}

function buildEmailOtpHtml(params: { otp: string; type: EmailOtpType }): string {
  const copy = getEmailOtpCopy(params.type);
  const code = escapeHtml(params.otp);

  return `
    <div style="background:#f8fafc;padding:32px 16px;font-family:Arial,sans-serif;color:#0f172a;">
      <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:20px;padding:32px;">
        <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0369a1;">Creator Assistant</p>
        <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;">${escapeHtml(copy.title)}</h1>
        <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#475569;">${escapeHtml(copy.body)}</p>
        <div style="margin:0 0 24px;padding:18px 20px;border-radius:16px;background:#eff6ff;border:1px solid #bae6fd;text-align:center;">
          <div style="font-size:28px;font-weight:700;letter-spacing:0.28em;color:#0f172a;">${code}</div>
        </div>
        <p style="margin:0;font-size:13px;line-height:1.6;color:#64748b;">
          This code expires in a few minutes. If you did not request it, you can ignore this email.
        </p>
      </div>
    </div>
  `.trim();
}

export async function sendEmailOtpEmail(params: {
  email: string;
  otp: string;
  type: EmailOtpType;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();

  if (!apiKey) {
    throw new Error('RESEND_API_KEY is required for account security emails');
  }

  if (!from) {
    throw new Error('EMAIL_FROM is required for account security emails');
  }

  const copy = getEmailOtpCopy(params.type);
  const idempotencyDigest = await sha256Hex(
    `${params.type}:${params.email.toLowerCase()}:${params.otp}`
  );
  const response = await fetch(`${RESEND_BASE_URL}/emails`, {
    method: 'POST',
    signal: AbortSignal.timeout(RESEND_REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `account-security/${params.type}/${idempotencyDigest}`,
    },
    body: JSON.stringify({
      from,
      to: [params.email],
      subject: copy.subject,
      html: buildEmailOtpHtml(params),
      text: `${copy.title}\n\n${copy.body}\n\nCode: ${params.otp}\n\nIf you did not request this, you can ignore this email.`,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Resend email send failed with status ${response.status}: ${bodyText}`);
  }
}
