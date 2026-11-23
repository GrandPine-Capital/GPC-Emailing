-- The rest of Keycloak's account e-mails (the Keycloak e-mail theme, exported as HTML for the en
-- locale): verify with a code, confirm a new address, account alerts, identity-provider link,
-- organization invitations, the SMTP test. V10 has the three that POST /hooks/keycloak sends
-- today (set a new password, forgot password, verify e-mail address).
--
-- These are templates only: no event sends them yet, so Keycloak still sends its own. They are
-- here to be worded in the dashboard (Templates, category "transactional"), each with a key
-- (keycloak_...) for the hook to name once it carries these events.
-- Merge tags, as in V10 where they overlap: action_url, expires_in, realm_name, first_name,
-- last_name; and new_email, code, event_date, event_ip_address, credential_type,
-- identity_provider_name, identity_provider_username, organization_name.
INSERT INTO templates (id, key, name, category, mode, subject, html, is_standard) VALUES
('txn-keycloak-email-test', 'keycloak_email_test', 'Keycloak: SMTP test message', 'transactional', 'html',
 '[KEYCLOAK] - SMTP test message',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>[KEYCLOAK] - SMTP test message</title>
</head>
<body>
<p>This is a test message</p>
</body>
</html>$tpl$, false),
('txn-keycloak-email-update-confirmation', 'keycloak_email_update_confirmation', 'Keycloak: Verify new email address', 'transactional', 'html',
 'Verify new email',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Verify new email</title>
</head>
<body>
<p>To update your {{realm_name}} account with email address {{new_email}}, click the link below</p><p><a href="{{action_url}}">{{action_url}}</a></p><p>This link will expire within {{expires_in}}.</p><p>If you don't want to proceed with this modification, just ignore this message.</p>
</body>
</html>$tpl$, false),
('txn-keycloak-email-verification-with-code', 'keycloak_email_verification_with_code', 'Keycloak: Verify email (code)', 'transactional', 'html',
 'Verify email',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Verify email</title>
</head>
<body>
<p>Please verify your email address by entering in the following code.</p><p><b>{{code}}</b></p>
</body>
</html>$tpl$, false),
('txn-keycloak-event-login-error', 'keycloak_event_login_error', 'Keycloak alert: failed login attempt', 'transactional', 'html',
 'Login error',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Login error</title>
</head>
<body>
<p>A failed login attempt was detected to your account on {{event_date}} from {{event_ip_address}}. If this was not you, please contact an administrator.</p>
</body>
</html>$tpl$, false),
('txn-keycloak-event-remove-credential', 'keycloak_event_remove_credential', 'Keycloak alert: credential removed', 'transactional', 'html',
 'Remove credential',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Remove credential</title>
</head>
<body>
<p>Credential {{credential_type}} was removed from your account on {{event_date}} from {{event_ip_address}}. If this was not you, please contact an administrator.</p>
</body>
</html>$tpl$, false),
('txn-keycloak-event-remove-totp', 'keycloak_event_remove_totp', 'Keycloak alert: OTP removed', 'transactional', 'html',
 'Remove OTP',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Remove OTP</title>
</head>
<body>
<p>OTP was removed from your account on {{event_date}} from {{event_ip_address}}. If this was not you, please contact an administrator.</p>
</body>
</html>$tpl$, false),
('txn-keycloak-event-update-credential', 'keycloak_event_update_credential', 'Keycloak alert: credential changed', 'transactional', 'html',
 'Update credential',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Update credential</title>
</head>
<body>
<p>Your {{credential_type}} credential was changed on {{event_date}} from {{event_ip_address}}. If this was not you, please contact an administrator.</p>
</body>
</html>$tpl$, false),
('txn-keycloak-event-update-password', 'keycloak_event_update_password', 'Keycloak alert: password changed', 'transactional', 'html',
 'Update password',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Update password</title>
</head>
<body>
<p>Your password was changed on {{event_date}} from {{event_ip_address}}. If this was not you, please contact an administrator.</p>
</body>
</html>$tpl$, false),
('txn-keycloak-event-update-totp', 'keycloak_event_update_totp', 'Keycloak alert: OTP updated', 'transactional', 'html',
 'Update OTP',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Update OTP</title>
</head>
<body>
<p>OTP was updated for your account on {{event_date}} from {{event_ip_address}}. If this was not you, please contact an administrator.</p>
</body>
</html>$tpl$, false),
('txn-keycloak-event-user-disabled-by-permanent-lockout', 'keycloak_event_user_disabled_by_permanent_lockout', 'Keycloak alert: account locked permanently', 'transactional', 'html',
 'User disabled by permament lockout',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>User disabled by permament lockout</title>
</head>
<body>
<p>Your user has been disabled permanently because of multiple failed attemps on {{event_date}}. Please contact an administrator.</p>
</body>
</html>$tpl$, false),
('txn-keycloak-event-user-disabled-by-temporary-lockout', 'keycloak_event_user_disabled_by_temporary_lockout', 'Keycloak alert: account locked temporarily', 'transactional', 'html',
 'User disabled by temporary lockout',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>User disabled by temporary lockout</title>
</head>
<body>
<p>Your user has been disabled temporarily because of multiple failed attemps on {{event_date}}. Please contact an administrator if needed.</p>
</body>
</html>$tpl$, false),
('txn-keycloak-identity-provider-link', 'keycloak_identity_provider_link', 'Keycloak: Link identity provider', 'transactional', 'html',
 'Link {{identity_provider_name}}',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Link {{identity_provider_name}}</title>
</head>
<body>
<p>Someone wants to link your <b>{{realm_name}}</b> account with <b>{{identity_provider_name}}</b> account of user {{identity_provider_username}}. If this was you, click the link below to link accounts</p><p><a href="{{action_url}}">Link to confirm account linking</a></p><p>This link will expire within {{expires_in}}.</p><p>If you don't want to link account, just ignore this message. If you link accounts, you will be able to login to {{realm_name}} through {{identity_provider_name}}.</p>
</body>
</html>$tpl$, false),
('txn-keycloak-org-invite-personalized', 'keycloak_org_invite_personalized', 'Keycloak: Organization invitation (personalised)', 'transactional', 'html',
 'Invitation to join the {{organization_name}} organization',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Invitation to join the {{organization_name}} organization</title>
</head>
<body>
<p>Hi, {{first_name}} {{last_name}}.</p><p>You were invited to join the {{organization_name}} organization. Click the link below to join. </p><p><a href="{{action_url}}">Link to join the organization</a></p><p>This link will expire within {{expires_in}}.</p><p>If you dont want to join the organization, just ignore this message.</p>
</body>
</html>$tpl$, false),
('txn-keycloak-org-invite', 'keycloak_org_invite', 'Keycloak: Organization invitation', 'transactional', 'html',
 'Invitation to join the {{organization_name}} organization',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Invitation to join the {{organization_name}} organization</title>
</head>
<body>
<p>You were invited to join the {{organization_name}} organization. Click the link below to join. </p><p><a href="{{action_url}}">Link to join the organization</a></p><p>This link will expire within {{expires_in}}.</p><p>If you dont want to join the organization, just ignore this message.</p>
</body>
</html>$tpl$, false)
ON CONFLICT DO NOTHING;
