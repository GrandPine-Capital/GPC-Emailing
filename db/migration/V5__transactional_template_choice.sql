-- Staff choose which template each transactional e-mail uses (Transactional page). The row
-- keeps the template chosen when it was queued; template_key stays the default to fall back on.
ALTER TABLE transactional ADD COLUMN template_id text;
