-- Receipts go from no-reply@grandpine.com until billing@grandpine.com is approved, so the
-- starter templates say not to reply instead of inviting replies. Only templates still
-- carrying the original sentence change: wording staff edited is left alone.
UPDATE templates SET html = replace(html, '<p>Questions? Just reply to this e-mail.</p>',
    '<p style="font-size:13px;color:#6b7280;">This is an automated e-mail; please do not reply to it.</p>'), updated_at = now()
WHERE key IN ('payment_receipt', 'payment_refunded');

UPDATE templates SET html = replace(html, '<p>We will e-mail your receipt once the transfer is confirmed. Questions? Just reply to this e-mail.</p>',
    '<p>We will e-mail your receipt once the transfer is confirmed.</p>' || chr(10) ||
    '<p style="font-size:13px;color:#6b7280;">This is an automated e-mail; please do not reply to it.</p>'), updated_at = now()
WHERE key = 'payment_pending';
