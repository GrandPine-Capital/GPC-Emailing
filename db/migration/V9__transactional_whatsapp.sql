-- Transactional WhatsApp: the payment events that send an e-mail can also send the buyer a
-- WhatsApp message, through GPC-WhatsApp's API. A row is one message on one channel; a
-- WhatsApp row's to_phone is the number in international digits (to_email is kept when the
-- order has one, so a search by address finds both).
ALTER TABLE transactional ADD COLUMN channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'whatsapp'));
ALTER TABLE transactional ADD COLUMN to_phone text NOT NULL DEFAULT '';
-- Staff resends, counted so a resent WhatsApp goes under a new idempotency key while the
-- worker's retries of one send keep the same key (GPC-WhatsApp then sends it once).
ALTER TABLE transactional ADD COLUMN resends integer NOT NULL DEFAULT 0;
