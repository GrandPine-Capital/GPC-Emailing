-- The "first charge in 3 days" notice for a plan sold with free days (GPC-Payment's
-- subscription.charge_upcoming, from Stripe's customer.subscription.trial_will_end), through
-- POST /hooks/payments. Edit the wording in the dashboard; keep the key.
INSERT INTO templates (id, key, name, category, mode, subject, html, is_standard) VALUES
('txn-subscription-charge-upcoming', 'subscription_charge_upcoming', 'Plan first-charge notice', 'transactional', 'html',
 'Your ValueFarm Pro plan: first charge in 3 days',
$$<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;">
<tr><td style="padding:28px 32px 8px;font-size:20px;font-weight:bold;color:#14532d;">GrandPine Capital</td></tr>
<tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6;">
<p>Hi {{first_name|there}},</p>
<p>Your free days on {{item}} end on <strong>{{charge_at}}</strong>.</p>
<p>On that date the card on file will be charged <strong>{{charge_amount}}</strong>, and then every year until you cancel.</p>
<p>To change the card or cancel, open <strong>Manage plan</strong> in ValueFarm Settings. Cancel before {{charge_at}} and nothing is charged.</p>
</td></tr>
<tr><td style="padding:8px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.6;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;">
<tr><td style="padding:10px 0;color:#6b7280;">Plan</td><td align="right" style="padding:10px 0;">{{item}}</td></tr>
<tr><td style="padding:10px 0;color:#6b7280;">First charge</td><td align="right" style="padding:10px 0;font-weight:bold;">{{charge_amount}}</td></tr>
<tr><td style="padding:10px 0;color:#6b7280;">Charged on</td><td align="right" style="padding:10px 0;">{{charge_at}}</td></tr>
<tr><td style="padding:10px 0;color:#6b7280;">Order number</td><td align="right" style="padding:10px 0;">{{order_id}}</td></tr>
</table>
</td></tr>
<tr><td style="padding:16px 32px 8px;font-size:15px;line-height:1.6;">
<p>Questions? Just reply to this e-mail.</p>
</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;color:#9ca3af;">{{company_address}}</td></tr>
</table></td></tr></table>
</body></html>$$, false);
