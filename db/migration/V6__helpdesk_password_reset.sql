-- The Helpdesk (GPC-CSTicket) customer password-reset e-mail, asked for through
-- POST /hooks/helpdesk (event helpdesk.password_reset). Edit the wording in the dashboard; keep the key.
INSERT INTO templates (id, key, name, category, mode, subject, html, is_standard) VALUES
('txn-helpdesk-password-reset', 'helpdesk_password_reset', 'Helpdesk password reset', 'transactional', 'html',
 'Reset your GrandPine Helpdesk password',
$$<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;">
<tr><td style="padding:28px 32px 8px;font-size:20px;font-weight:bold;color:#14532d;">GrandPine Capital</td></tr>
<tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6;">
<p>Hi {{first_name|there}},</p>
<p>Someone asked to reset the password of your GrandPine Helpdesk account. Choose a new password with the button below.</p>
</td></tr>
<tr><td style="padding:16px 32px 8px;font-size:15px;line-height:1.6;">
<p><a href="{{reset_url}}" style="display:inline-block;background:#14532d;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:6px;">Choose a new password</a></p>
<p style="font-size:13px;color:#6b7280;">The link works for one hour (until {{expires_at}}).</p>
<p style="font-size:13px;color:#6b7280;">If this wasn't you, ignore this e-mail: your password stays the same.</p>
<p style="font-size:13px;color:#6b7280;">This is an automated e-mail; please do not reply to it.</p>
</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;color:#9ca3af;">{{company_address}}</td></tr>
</table></td></tr></table>
</body></html>$$, false);
