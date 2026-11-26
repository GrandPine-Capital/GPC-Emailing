-- E-mails the CRM (GPC-Lead) asks for through POST /hooks/crm/events (signed with the admin
-- setting crm_hook_secret). Edit the wording in the dashboard; keep the keys. Merge tags:
-- first_name, full_name, product, amount, currency, reference, company_address; the owner alert
-- (staff only) is just {{subject}} and {{body}}, which the CRM writes (HTML-escaped on merge).
-- Safe to run where the same rows already exist (the staging copy of this file is V12).
-- All four events are on by default: nothing is stored in the settings for that.
INSERT INTO templates (id, key, name, category, mode, subject, html, is_standard) VALUES
('txn-crm-payment-failed', 'crm_payment_failed', 'CRM: payment failed', 'transactional', 'html',
 'Your payment didn''t go through ｜ 您的付款未成功',
$$<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;">
<tr><td style="padding:28px 32px 8px;font-size:20px;font-weight:bold;color:#14532d;">GrandPine Capital</td></tr>
<tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6;">
<p>Hi {{first_name|there}},</p>
<p>Unfortunately your payment for {{product|your order}} ({{currency}} {{amount}}) did not go through, so it is not confirmed yet.</p>
<p>Reference: {{reference}}</p>
<p>Please contact us and we will help you complete it.</p>
</td></tr>
<tr><td style="padding:0 32px;"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
<tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6;">
<p>{{first_name|你好}}，</p>
<p>很抱歉，您为 {{product|您的订单}}（{{currency}} {{amount}}）所做的付款未成功，因此尚未确认。</p>
<p>参考编号：{{reference}}</p>
<p>请联系我们，我们会协助您完成付款。</p>
</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;color:#9ca3af;">{{company_address}}</td></tr>
</table></td></tr></table>
</body></html>$$, false),
('txn-crm-registration-confirmed', 'crm_registration_confirmed', 'CRM: registration confirmed', 'transactional', 'html',
 'Your registration is confirmed ｜ 您的报名已确认',
$$<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;">
<tr><td style="padding:28px 32px 8px;font-size:20px;font-weight:bold;color:#14532d;">GrandPine Capital</td></tr>
<tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6;">
<p>Hi {{first_name|there}},</p>
<p>Thank you! Your registration for {{product|our programme}} is confirmed.</p>
<p>Reference: {{reference}}</p>
<p>We will be in touch with the details.</p>
</td></tr>
<tr><td style="padding:0 32px;"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
<tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6;">
<p>{{first_name|你好}}，</p>
<p>谢谢您！您报名 {{product|我们的课程}} 已确认。</p>
<p>参考编号：{{reference}}</p>
<p>我们会再与您联系并提供详细信息。</p>
</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;color:#9ca3af;">{{company_address}}</td></tr>
</table></td></tr></table>
</body></html>$$, false),
('txn-crm-registration-failed', 'crm_registration_failed', 'CRM: registration failed', 'transactional', 'html',
 'We couldn''t complete your registration ｜ 我们未能完成您的报名',
$$<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;">
<tr><td style="padding:28px 32px 8px;font-size:20px;font-weight:bold;color:#14532d;">GrandPine Capital</td></tr>
<tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6;">
<p>Hi {{first_name|there}},</p>
<p>We could not complete your registration for {{product|our programme}}.</p>
<p>Reference: {{reference}}</p>
<p>Please contact us and we will sort it out for you.</p>
</td></tr>
<tr><td style="padding:0 32px;"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
<tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6;">
<p>{{first_name|你好}}，</p>
<p>我们未能完成您对 {{product|我们的课程}} 的报名登记。</p>
<p>参考编号：{{reference}}</p>
<p>请联系我们，我们会立即为您处理。</p>
</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;color:#9ca3af;">{{company_address}}</td></tr>
</table></td></tr></table>
</body></html>$$, false),
('txn-crm-owner-alert', 'crm_owner_alert', 'CRM: alert to staff', 'transactional', 'html',
 '{{subject}}',
$$<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;">
<tr><td style="padding:28px 32px 8px;font-size:20px;font-weight:bold;color:#14532d;">GrandPine Capital</td></tr>
<tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6;">
<p style="font-size:13px;color:#6b7280;">Internal alert from the CRM</p>
<div style="white-space:pre-wrap;">{{body}}</div>
</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;color:#9ca3af;">{{company_address}}</td></tr>
</table></td></tr></table>
</body></html>$$, false)
ON CONFLICT DO NOTHING;
