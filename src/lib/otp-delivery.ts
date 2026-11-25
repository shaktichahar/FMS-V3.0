import nodemailer from 'nodemailer';
import type { OtpDeliveryInfo } from '../types/finance.ts';

export const ADMIN_GMAIL = 'shakti.chahar@gmail.com';

export function normalizeEmail(raw: string): string {
  return String(raw || '').trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/**
 * Normalizes mobile numbers to E.164 format.
 * 10-digit Indian mobile numbers automatically receive the +91 prefix.
 */
export function normalizeMobile(raw: string): string {
  const cleaned = String(raw || '').trim().replace(/[\s\-()]/g, '');
  if (!cleaned) return '';
  if (/^\d{10}$/.test(cleaned)) {
    return `+91${cleaned}`;
  }
  if (/^91\d{10}$/.test(cleaned)) {
    return `+${cleaned}`;
  }
  if (/^\+\d{10,15}$/.test(cleaned)) {
    return cleaned;
  }
  return cleaned;
}

export function isValidMobile(mobile: string): boolean {
  const normalized = normalizeMobile(mobile);
  return /^\+\d{10,15}$/.test(normalized);
}

export function maskEmail(email?: string | null): string | null {
  const clean = normalizeEmail(email || '');
  if (!clean || !clean.includes('@')) return null;
  const [local, domain] = clean.split('@');
  if (local.length <= 2) {
    return `${local[0] || '*'}***@${domain}`;
  }
  return `${local.slice(0, 2)}${'*'.repeat(Math.min(5, Math.max(2, local.length - 2)))}@${domain}`;
}

export function maskMobile(mobile?: string | null): string | null {
  const clean = normalizeMobile(mobile || '');
  if (!clean || clean.length < 6) return null;
  const last4 = clean.slice(-4);
  const prefix = clean.startsWith('+91') ? '+91' : clean.slice(0, 3);
  return `${prefix} ••••••${last4}`;
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendEmailOtpViaWebhook(
  toEmail: string,
  fullName: string,
  loginIdentifier: string,
  otp: string,
  purpose: 'login' | 'direct-otp' | 'register' = 'login'
): Promise<boolean> {
  const webhookUrl = process.env.OTP_EMAIL_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return false;
  }
  const secret = process.env.OTP_EMAIL_WEBHOOK_SECRET?.trim() || '';
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    redirect: 'follow',
    body: JSON.stringify({
      to: toEmail,
      fullName,
      loginIdentifier,
      otp,
      purpose,
      secret,
    }),
  });
  const text = await res.text().catch(() => '');
  let parsed: { ok?: boolean; error?: string } | null = null;
  try {
    parsed = JSON.parse(text) as { ok?: boolean; error?: string };
  } catch {
    parsed = null;
  }
  if (!res.ok || (parsed && parsed.ok === false)) {
    throw new Error(parsed?.error || `Email webhook failed (${res.status}).`);
  }
  return true;
}

function normalizeSmtpPassword(raw: string | undefined, isGmailHost: boolean): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  // Google displays 16-character App Passwords with spaces (e.g. "abcd efgh ijkl mnop")
  return isGmailHost ? cleaned.replace(/\s+/g, '') : cleaned;
}

function formatSmtpFailureMessage(err: unknown): string {
  const rawMsg = err instanceof Error ? err.message : String(err || '');
  if (/534-5\.7\.9|Application-specific password required/i.test(rawMsg)) {
    return 'Gmail requires a 16-character Google App Password (not your regular Gmail password). Enable 2-Step Verification at myaccount.google.com/apppasswords, generate an App Password for "LedgerFlow", and save it as GMAIL_APP_PASSWORD in Settings → Secrets (or set OTP_EMAIL_WEBHOOK_URL instead).';
  }
  if (/535-5\.7\.8|Username and Password not accepted/i.test(rawMsg)) {
    return 'Gmail rejected SMTP credentials (535-5.7.8). Verify SMTP_USER matches your Gmail address and GMAIL_APP_PASSWORD is a valid 16-character Google App Password.';
  }
  return '';
}

export function isOtpDeliveryConfigured(): boolean {
  const hasWebhook = Boolean(process.env.OTP_EMAIL_WEBHOOK_URL?.trim());
  const host = process.env.SMTP_HOST?.trim() || 'smtp.gmail.com';
  const isGmailHost = host.toLowerCase() === 'smtp.gmail.com';
  const hasSmtpPass = Boolean(
    normalizeSmtpPassword(process.env.SMTP_PASS, isGmailHost) ||
      normalizeSmtpPassword(process.env.GMAIL_APP_PASSWORD, isGmailHost)
  );
  const hasTwilio = Boolean(
    process.env.TWILIO_ACCOUNT_SID?.trim() &&
      process.env.TWILIO_AUTH_TOKEN?.trim() &&
      process.env.TWILIO_FROM_NUMBER?.trim()
  );
  return hasWebhook || hasSmtpPass || hasTwilio;
}

async function sendEmailOtp(
  toEmail: string,
  fullName: string,
  loginIdentifier: string,
  otp: string,
  purpose: 'login' | 'direct-otp' | 'register' = 'login'
): Promise<boolean> {
  const hasWebhook = Boolean(process.env.OTP_EMAIL_WEBHOOK_URL?.trim());
  const host = process.env.SMTP_HOST?.trim() || 'smtp.gmail.com';
  const isGmailHost = host.toLowerCase() === 'smtp.gmail.com';
  const gmailPass = normalizeSmtpPassword(process.env.GMAIL_APP_PASSWORD, isGmailHost);
  const smtpPass = normalizeSmtpPassword(process.env.SMTP_PASS, isGmailHost) || gmailPass;

  if (hasWebhook) {
    try {
      const sent = await sendEmailOtpViaWebhook(toEmail, fullName, loginIdentifier, otp, purpose);
      if (sent) {
        return true;
      }
    } catch (webhookErr) {
      console.error(
        'OTP email webhook delivery failed:',
        webhookErr instanceof Error ? webhookErr.message : webhookErr
      );
      if (!smtpPass) {
        throw webhookErr;
      }
    }
  }

  if (!smtpPass) {
    return false;
  }

  const user = process.env.SMTP_USER?.trim() || ADMIN_GMAIL;
  const port = Number(process.env.SMTP_PORT || (isGmailHost ? 465 : 587));
  const secure =
    process.env.SMTP_SECURE !== undefined
      ? process.env.SMTP_SECURE === 'true'
      : port === 465;
  const from = process.env.SMTP_FROM?.trim() || `LedgerFlow Security <${user}>`;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass: smtpPass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });

  const plainName = String(fullName || '').replace(/[\r\n<>]/g, '').trim();
  const plainLogin = String(loginIdentifier || '').replace(/[\r\n<>]/g, '').trim();
  const safeNameHtml = escapeHtml(plainName);
  const safeLoginHtml = escapeHtml(plainLogin);

  const isRegistration = purpose === 'register';
  const subject = isRegistration
    ? `Verify Your Email — Registration OTP (${otp})`
    : `LedgerFlow Login OTP (${otp}) — ${plainLogin}`;
  const heading = isRegistration ? 'Verify Your Registered Email' : 'LedgerFlow Login Verification';
  const bodyLead = isRegistration
    ? 'Use the one-time verification code below to verify your registered email address. Once verified, an administrator will review and approve your account before you can sign in:'
    : 'Use the one-time verification code below to complete sign-in:';
  const plainText = isRegistration
    ? `Hello ${plainName},\n\nThank you for creating an account (${plainLogin}).\n\nYour 6-digit email verification OTP is: ${otp}\n\nThis code expires in 5 minutes and can only be used once. After verifying your email, your account will await administrator approval before sign-in is enabled.`
    : `Hello ${plainName},\n\nA login verification OTP was requested for account: ${plainLogin}\n\nYour 6-digit LedgerFlow OTP is: ${otp}\n\nThis code expires in 5 minutes and can only be used once.`;

  await transporter.sendMail({
    from,
    to: toEmail,
    subject,
    text: plainText,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px;">
        <h2 style="margin: 0 0 12px; color: #0f172a; font-size: 18px;">${heading}</h2>
        <p style="margin: 0 0 8px; color: #475569; font-size: 14px;">Account: <strong>${safeNameHtml}</strong> (${safeLoginHtml})</p>
        <p style="margin: 0 0 16px; color: #475569; font-size: 14px;">${bodyLead}</p>
        <div style="background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 10px; padding: 16px; text-align: center; font-size: 28px; font-weight: 700; letter-spacing: 8px; color: #1d358f; font-family: monospace;">
          ${otp}
        </div>
        <p style="margin: 16px 0 0; color: #64748b; font-size: 12px;">This code is valid for 5 minutes and can only be used once.</p>
      </div>
    `,
  });

  return true;
}

async function sendSmsOtp(toMobile: string, otp: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_FROM_NUMBER?.trim();
  if (!sid || !token || !from) {
    return false;
  }

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const body = new URLSearchParams({
    To: toMobile,
    From: from,
    Body: `LedgerFlow OTP: ${otp}. Valid for 5 minutes. Do not share this code with anyone.`,
  });

  const authHeader = Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authHeader}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`SMS gateway error (${res.status}): ${errText.slice(0, 120)}`);
  }

  return true;
}

/**
 * Dispatches OTP directly to the user's own registered email and/or registered mobile number.
 * Never returns an on-screen preview code; throws if live email/SMS delivery is unavailable.
 */
export async function dispatchLoginOtp(params: {
  fullName: string;
  loginIdentifier: string;
  email?: string | null;
  mobile?: string | null;
  otp: string;
  purpose?: 'login' | 'direct-otp' | 'register';
}): Promise<OtpDeliveryInfo> {
  const purpose = params.purpose || 'login';
  const isRegistration = purpose === 'register';
  const cleanEmail = normalizeEmail(params.email || '');
  const hasEmail = isValidEmail(cleanEmail);
  const cleanMobile = normalizeMobile(params.mobile || '');
  const hasMobile = !isRegistration && isValidMobile(cleanMobile);

  const channels: Array<'email' | 'mobile'> = [];
  if (hasEmail) channels.push('email');
  if (hasMobile) channels.push('mobile');

  let emailSent = false;
  let smsSent = false;
  const failures: string[] = [];
  let emailFailureReason = '';

  if (hasEmail) {
    try {
      emailSent = await sendEmailOtp(
        cleanEmail,
        params.fullName,
        params.loginIdentifier,
        params.otp,
        purpose
      );
    } catch (err) {
      console.error('OTP email delivery failed:', err instanceof Error ? err.message : err);
      failures.push('Email');
      emailFailureReason = formatSmtpFailureMessage(err);
    }
  }

  if (hasMobile) {
    try {
      smsSent = await sendSmsOtp(cleanMobile, params.otp);
    } catch (err) {
      console.error('OTP SMS delivery failed:', err instanceof Error ? err.message : err);
      failures.push('SMS');
    }
  }

  const displayEmail = hasEmail ? maskEmail(cleanEmail) || cleanEmail : null;
  const displayMobile = hasMobile ? maskMobile(cleanMobile) || cleanMobile : null;

  if (emailSent || smsSent) {
    const deliveredParts: string[] = [];
    if (emailSent && displayEmail) {
      deliveredParts.push(`registered email (${displayEmail})`);
    }
    if (smsSent && displayMobile) {
      deliveredParts.push(`registered mobile (${displayMobile})`);
    }
    const notice =
      failures.length > 0
        ? `OTP sent to your ${deliveredParts.join(' and ')} (${failures.join('/')} gateway unavailable).`
        : `OTP sent to your ${deliveredParts.join(' and ')}. Please check your inbox.`;

    return {
      emailSent,
      smsSent,
      mode: 'live',
      channels,
      notice,
    };
  }

  if (emailFailureReason) {
    throw new Error(emailFailureReason);
  }

  if (failures.length > 0) {
    throw new Error(
      `Unable to send OTP to your registered email (${displayEmail || 'registered address'}). Please check your email delivery configuration and try again.`
    );
  }

  throw new Error(
    'Live Email/SMS OTP delivery is not configured on the server yet. Add GMAIL_APP_PASSWORD or OTP_EMAIL_WEBHOOK_URL in Settings → Secrets (or Cloud Run Variables) and redeploy — or sign in right now using the "Password + OTP" tab with your password.'
  );
}
