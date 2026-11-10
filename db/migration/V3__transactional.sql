-- Transactional e-mail: receipts, bank-transfer instructions and refund notices that other
-- GrandPine systems (GPC-Payment first) ask this service to send. They are not marketing:
-- the recipient is not made a contact, unsubscribe does not stop them, they carry no
-- unsubscribe footer and no open or click tracking.

-- A template with a key is the one a system names when it asks for a send
-- ('payment_receipt', ...). Staff edit its subject and HTML in the dashboard like any other.
ALTER TABLE templates ADD COLUMN key text UNIQUE;

CREATE TABLE transactional (
    id             text PRIMARY KEY,
    -- Who asked ('payment') and its idempotency key for the send (e.g. 'payment.succeeded:<order id>'):
    -- asking twice sends once.
    source         text NOT NULL,
    source_key     text NOT NULL,
    template_key   text NOT NULL,
    to_email       text NOT NULL,
    to_name        text NOT NULL DEFAULT '',
    -- The merge values the template is rendered with ({{amount}}, {{receipt_url}}, ...).
    vars           jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- The system's own record (the payment id), so staff can find every e-mail about it.
    reference      text NOT NULL DEFAULT '',
    from_email     text NOT NULL DEFAULT '',
    subject        text NOT NULL DEFAULT '',
    status         text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'sent', 'failed', 'skipped', 'bounced', 'complained')),
    attempts       integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    error          text,
    provider_id    text,  -- the SES message id
    rfc_message_id text,
    dry_run        boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    sent_at        timestamptz,
    UNIQUE (source, source_key)
);
CREATE INDEX transactional_due ON transactional (next_attempt_at) WHERE status = 'queued';
CREATE INDEX transactional_provider ON transactional (provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX transactional_reference ON transactional (source, reference);
CREATE INDEX transactional_created ON transactional (created_at DESC);

-- The starter templates GPC-Payment's events use. Edit the wording in the dashboard; keep the key.
INSERT INTO templates (id, key, name, category, mode, subject, html, is_standard) VALUES
('txn-payment-receipt', 'payment_receipt', 'Payment receipt', 'transactional', 'html',
 'Payment received: {{item}} ({{amount}})',
$$<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;">
<tr><td style="padding:28px 32px 8px;font-size:20px;font-weight:bold;color:#14532d;">GrandPine Capital</td></tr>
<tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6;">
<p>Hi {{first_name|there}},</p>
<p>Thank you, we have received your payment.</p>
</td></tr>
<tr><td style="padding:8px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.6;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;">
<tr><td style="padding:10px 0;color:#6b7280;">Item</td><td align="right" style="padding:10px 0;">{{item}}</td></tr>
<tr><td style="padding:10px 0;color:#6b7280;">Amount paid</td><td align="right" style="padding:10px 0;font-weight:bold;">{{amount}}</td></tr>
<tr><td style="padding:10px 0;color:#6b7280;">Paid on</td><td align="right" style="padding:10px 0;">{{paid_at}}</td></tr>
<tr><td style="padding:10px 0;color:#6b7280;">Payment method</td><td align="right" style="padding:10px 0;">{{payment_method}}</td></tr>
<tr><td style="padding:10px 0;color:#6b7280;">Order number</td><td align="right" style="padding:10px 0;">{{order_id}}</td></tr>
</table>
</td></tr>
<tr><td style="padding:16px 32px 8px;font-size:15px;line-height:1.6;">
<p><a href="{{receipt_url}}" style="display:inline-block;background:#14532d;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:6px;">View your receipt</a></p>
<p style="font-size:13px;color:#6b7280;">For an event, the receipt page has the QR code you show at check-in.</p>
<p>Questions? Just reply to this e-mail.</p>
</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;color:#9ca3af;">{{company_address}}</td></tr>
</table></td></tr></table>
</body></html>$$, false),

('txn-payment-pending', 'payment_pending', 'Bank transfer instructions', 'transactional', 'html',
 'How to pay for {{item}} ({{amount}})',
$$<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;">
<tr><td style="padding:28px 32px 8px;font-size:20px;font-weight:bold;color:#14532d;">GrandPine Capital</td></tr>
<tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6;">
<p>Hi {{first_name|there}},</p>
<p>Your order is reserved. Please transfer <strong>{{amount}}</strong> to the account below, using the payment reference so we can match it to you.</p>
</td></tr>
<tr><td style="padding:8px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.6;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;">
<tr><td style="padding:10px 0;color:#6b7280;">Item</td><td align="right" style="padding:10px 0;">{{item}}</td></tr>
<tr><td style="padding:10px 0;color:#6b7280;">Amount</td><td align="right" style="padding:10px 0;font-weight:bold;">{{amount}}</td></tr>
<tr><td style="padding:10px 0;color:#6b7280;">Bank</td><td align="right" style="padding:10px 0;">{{bank_name}}</td></tr>
<tr><td style="padding:10px 0;color:#6b7280;">Account name</td><td align="right" style="padding:10px 0;">{{account_name}}</td></tr>
<tr><td style="padding:10px 0;color:#6b7280;">Account number</td><td align="right" style="padding:10px 0;font-weight:bold;">{{account_number}}</td></tr>
<tr><td style="padding:10px 0;color:#6b7280;">Payment reference</td><td align="right" style="padding:10px 0;font-weight:bold;">{{payment_reference}}</td></tr>
<tr><td style="padding:10px 0;color:#6b7280;">Pay by</td><td align="right" style="padding:10px 0;">{{expires_at|as soon as you can}}</td></tr>
</table>
</td></tr>
<tr><td style="padding:16px 32px 8px;font-size:15px;line-height:1.6;">
<p><a href="{{instructions_url}}" style="display:inline-block;background:#14532d;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:6px;">Payment instructions and upload proof</a></p>
<p>We will e-mail your receipt once the transfer is confirmed. Questions? Just reply to this e-mail.</p>
</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;color:#9ca3af;">{{company_address}}</td></tr>
</table></td></tr></table>
</body></html>$$, false),

('txn-payment-refunded', 'payment_refunded', 'Refund notice', 'transactional', 'html',
 'Your refund for {{item}}',
$$<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;">
<tr><td style="padding:28px 32px 8px;font-size:20px;font-weight:bold;color:#14532d;">GrandPine Capital</td></tr>
<tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6;">
<p>Hi {{first_name|there}},</p>
<p>We have refunded your payment for <strong>{{item}}</strong>. Depending on your bank or card, it can take a few working days to show in your account.</p>
</td></tr>
<tr><td style="padding:8px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.6;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;">
<tr><td style="padding:10px 0;color:#6b7280;">Amount</td><td align="right" style="padding:10px 0;font-weight:bold;">{{amount}}</td></tr>
<tr><td style="padding:10px 0;color:#6b7280;">Refunded on</td><td align="right" style="padding:10px 0;">{{refunded_at}}</td></tr>
<tr><td style="padding:10px 0;color:#6b7280;">Order number</td><td align="right" style="padding:10px 0;">{{order_id}}</td></tr>
</table>
</td></tr>
<tr><td style="padding:16px 32px 8px;font-size:15px;line-height:1.6;">
<p>Questions? Just reply to this e-mail.</p>
</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;color:#9ca3af;">{{company_address}}</td></tr>
</table></td></tr></table>
</body></html>$$, false);
