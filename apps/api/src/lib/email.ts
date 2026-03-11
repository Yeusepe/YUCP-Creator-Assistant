/**
 * Email sending via Resend
 * Uses loadEnv() so RESEND_API_KEY and EMAIL_FROM come from Infisical when configured.
 */

import { Resend } from 'resend';
import { CollabKeyAddedEmail } from '../emails/CollabKeyAddedEmail';
import { loadEnv } from './env';

export async function sendCollabKeyAddedEmail(params: {
  to: string;
  collaboratorDisplayName: string;
  serverName: string;
  addedAt: string;
  connectionId: string;
}): Promise<{ id?: string; error?: { message: string } }> {
  const env = loadEnv();
  const apiKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM;
  if (!apiKey) return { error: { message: 'RESEND_API_KEY not configured' } };
  if (!from) return { error: { message: 'EMAIL_FROM not configured' } };
  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send(
    {
      from,
      to: [params.to],
      subject: 'Your Jinxxy API key was added to a Discord server',
      react: CollabKeyAddedEmail(params),
    },
    { idempotencyKey: `collab-key-added/${params.connectionId}` }
  );
  return error ? { error } : { id: data?.id };
}
