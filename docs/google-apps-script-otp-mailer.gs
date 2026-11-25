/**
 * LedgerFlow Free Gmail OTP Mailer (Google Apps Script Web App)
 *
 * Setup (takes ~1 minute, 100% free, no billing required):
 * 1. Open https://script.google.com signed in with shakti.chahar@gmail.com
 * 2. Click "New project" -> paste this entire file into Code.gs -> Save.
 * 3. (Optional) Set SHARED_SECRET below (and add the same value as OTP_EMAIL_WEBHOOK_SECRET in GitHub Secrets).
 * 4. Click "Deploy" -> "New deployment" -> Type: "Web app":
 *      - Execute as: Me (shakti.chahar@gmail.com)
 *      - Who has access: Anyone
 * 5. Authorize when prompted, then copy the Web App URL (ends with /exec).
 * 6. Add that URL as OTP_EMAIL_WEBHOOK_URL in GitHub Repo Settings -> Secrets and variables -> Actions.
 */

const SHARED_SECRET = ''; // Optional: set a random token and match OTP_EMAIL_WEBHOOK_SECRET

function escapeHtml_(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function doPost(e) {
  try {
    const rawBody = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const data = JSON.parse(rawBody);

    if (SHARED_SECRET && String(data.secret || '') !== SHARED_SECRET) {
      return jsonOut_({ ok: false, error: 'Unauthorized OTP mailer request.' });
    }

    const toEmail = String(data.to || '').trim().toLowerCase();
    const otp = String(data.otp || '').replace(/\D/g, '').slice(0, 6);
    const fullName = String(data.fullName || 'LedgerFlow User').replace(/[\r\n<>]/g, '').trim();
    const loginIdentifier = String(data.loginIdentifier || toEmail).replace(/[\r\n<>]/g, '').trim();
    const purpose = String(data.purpose || 'login');

    if (!toEmail || toEmail.indexOf('@') < 1) {
      return jsonOut_({ ok: false, error: 'Invalid recipient email address.' });
    }
    if (otp.length !== 6) {
      return jsonOut_({ ok: false, error: 'Invalid 6-digit OTP payload.' });
    }

    const isRegistration = purpose === 'register';
    const subject = isRegistration
      ? 'Verify Your Email - LedgerFlow Registration OTP (' + otp + ')'
      : 'LedgerFlow Login OTP (' + otp + ') - ' + loginIdentifier;
    const heading = isRegistration
      ? 'Verify Your Registered Email'
      : 'LedgerFlow Login Verification';
    const bodyLead = isRegistration
      ? 'Use the one-time verification code below to verify your registered email address:'
      : 'Use the one-time verification code below to complete sign-in to LedgerFlow:';

    const plainBody =
      'Hello ' +
      fullName +
      ',\n\n' +
      'Account: ' +
      loginIdentifier +
      '\n\n' +
      'Your 6-digit LedgerFlow OTP is: ' +
      otp +
      '\n\nThis code expires in 5 minutes and can only be used once.';

    const htmlBody =
      '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px;">' +
      '<h2 style="margin:0 0 12px;color:#0f172a;font-size:18px;">' +
      escapeHtml_(heading) +
      '</h2>' +
      '<p style="margin:0 0 8px;color:#475569;font-size:14px;">Account: <strong>' +
      escapeHtml_(fullName) +
      '</strong> (' +
      escapeHtml_(loginIdentifier) +
      ')</p>' +
      '<p style="margin:0 0 16px;color:#475569;font-size:14px;">' +
      escapeHtml_(bodyLead) +
      '</p>' +
      '<div style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:16px;text-align:center;font-size:28px;font-weight:700;letter-spacing:8px;color:#1d358f;font-family:monospace;">' +
      escapeHtml_(otp) +
      '</div>' +
      '<p style="margin:16px 0 0;color:#64748b;font-size:12px;">This code is valid for 5 minutes and can only be used once.</p>' +
      '</div>';

    MailApp.sendEmail({
      to: toEmail,
      name: 'LedgerFlow Security',
      subject: subject,
      body: plainBody,
      htmlBody: htmlBody,
    });

    return jsonOut_({ ok: true });
  } catch (err) {
    return jsonOut_({
      ok: false,
      error: err && err.message ? String(err.message) : 'Failed to send OTP email.',
    });
  }
}
