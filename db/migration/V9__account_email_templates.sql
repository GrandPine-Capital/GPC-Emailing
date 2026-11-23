-- The sign-in and account e-mails of the staff and customer sign-in service (the Keycloak e-mail
-- theme, exported as HTML for the en locale): verify e-mail, reset password, account alerts,
-- organization invitations. They are here to be edited and chosen in the dashboard (Templates,
-- category "account"); each keeps a key, so whatever sends them later can name it. Nothing in
-- this service sends them yet: the sign-in service still sends its own copies.
-- Merge tags: link, link_expiration, realm_name, new_email, code, event_date, event_ip_address,
-- credential_type, identity_provider_name, identity_provider_username, organization_name,
-- first_name, last_name.
INSERT INTO templates (id, key, name, category, mode, subject, html, is_standard) VALUES
('acct-email-test', 'account_email_test', 'SMTP test message', 'account', 'html',
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
('acct-email-update-confirmation', 'account_email_update_confirmation', 'Verify new email address', 'account', 'html',
 'Verify new email',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Verify new email</title>
</head>
<body>
<p>To update your {{realm_name}} account with email address {{new_email}}, click the link below</p><p><a href="{{link}}">{{link}}</a></p><p>This link will expire within {{link_expiration}}.</p><p>If you don't want to proceed with this modification, just ignore this message.</p>
</body>
</html>$tpl$, false),
('acct-email-verification-with-code', 'account_email_verification_with_code', 'Verify email (code)', 'account', 'html',
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
('acct-email-verification', 'account_email_verification', 'Verify email (link)', 'account', 'html',
 'Verify email',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Verify email</title>
</head>
<body>
<p>Someone has created a {{realm_name}} account with this email address. If this was you, click the link below to verify your email address</p><p><a href="{{link}}">Link to e-mail address verification</a></p><p>This link will expire within {{link_expiration}}.</p><p>If you didn't create this account, just ignore this message.</p>
</body>
</html>$tpl$, false),
('acct-event-login-error', 'account_event_login_error', 'Alert: failed login attempt', 'account', 'html',
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
('acct-event-remove-credential', 'account_event_remove_credential', 'Alert: credential removed', 'account', 'html',
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
('acct-event-remove-totp', 'account_event_remove_totp', 'Alert: OTP removed', 'account', 'html',
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
('acct-event-update-credential', 'account_event_update_credential', 'Alert: credential changed', 'account', 'html',
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
('acct-event-update-password', 'account_event_update_password', 'Alert: password changed', 'account', 'html',
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
('acct-event-update-totp', 'account_event_update_totp', 'Alert: OTP updated', 'account', 'html',
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
('acct-event-user-disabled-by-permanent-lockout', 'account_event_user_disabled_by_permanent_lockout', 'Alert: account locked permanently', 'account', 'html',
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
('acct-event-user-disabled-by-temporary-lockout', 'account_event_user_disabled_by_temporary_lockout', 'Alert: account locked temporarily', 'account', 'html',
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
('acct-execute-actions', 'account_execute_actions', 'Required account action (ValueFarm password reset announcement)', 'account', 'html',
 'ValueFarm: reset your password ｜ ValueFarm：请重设你的密码',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>ValueFarm: reset your password ｜ ValueFarm：请重设你的密码</title>
</head>
<body>
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">All ValueFarm users are required to reset their password. ValueFarm 安全系统已升级，所有用户需重设密码。</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F2F5FA;"><tr><td align="center" style="padding:24px 10px;"><table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;"><tr><td style="padding:10px 36px;background:#0A1A3F;font-family:'Helvetica Neue',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;font-size:12px;letter-spacing:1px;color:#ffffff;text-align:center;">ENGLISH</td></tr><tr><td style="padding:0;background:#ffffff;"><img src="https://vf-media-prod-folders.s3.ap-southeast-5.amazonaws.com/edm/Important+Announcement_EN.jpeg" alt="ValueFarm Important Announcement: account security system fully updated" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr><tr><td style="padding:32px 36px 8px 36px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;"><p style="margin:0 0 6px 0;font-size:13px;letter-spacing:1px;color:#0B6BF5;font-weight:bold;">ATTENTION TO ALL VALUEFARM USERS</p><h1 style="margin:0 0 14px 0;font-size:22px;line-height:1.4;color:#0A1A3F;">We’ve upgraded ValueFarm’s account security</h1><p style="margin:0 0 20px 0;font-size:15px;line-height:1.7;color:#1a2440;">All ValueFarm users need to reset their password before logging in to ValueFarm again. Here’s how:</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;"><tr><td width="36" valign="top" style="padding:0 0 14px 0;"><div style="width:26px;height:26px;line-height:26px;border-radius:13px;background:#0B6BF5;color:#ffffff;text-align:center;font-size:13px;font-weight:bold;">1</div></td><td valign="top" style="padding:3px 0 14px 0;font-size:15px;line-height:1.6;color:#1a2440;">Go to our official website: <a href="https://web.valuefarm.com" style="color:#0B6BF5;font-weight:bold;">https://web.valuefarm.com</a></td></tr><tr><td width="36" valign="top" style="padding:0 0 14px 0;"><div style="width:26px;height:26px;line-height:26px;border-radius:13px;background:#0B6BF5;color:#ffffff;text-align:center;font-size:13px;font-weight:bold;">2</div></td><td valign="top" style="padding:3px 0 14px 0;font-size:15px;line-height:1.6;color:#1a2440;">Enter the email address registered with ValueFarm</td></tr><tr><td width="36" valign="top" style="padding:0 0 14px 0;"><div style="width:26px;height:26px;line-height:26px;border-radius:13px;background:#0B6BF5;color:#ffffff;text-align:center;font-size:13px;font-weight:bold;">3</div></td><td valign="top" style="padding:3px 0 14px 0;font-size:15px;line-height:1.6;color:#1a2440;">Follow the instructions in the password reset email</td></tr><tr><td width="36" valign="top" style="padding:0 0 14px 0;"><div style="width:26px;height:26px;line-height:26px;border-radius:13px;background:#0B6BF5;color:#ffffff;text-align:center;font-size:13px;font-weight:bold;">4</div></td><td valign="top" style="padding:3px 0 14px 0;font-size:15px;line-height:1.6;color:#1a2440;">Return to the website and log in with your new password</td></tr></table></td></tr><tr><td align="center" style="padding:16px 36px 12px 36px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td align="center" bgcolor="#0B6BF5" style="border-radius:8px;"><a href="{{link}}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Reset My Password</a></td></tr></table></td></tr><tr><td style="padding:0 36px 20px 36px;text-align:center;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#8a93a8;">This link will expire within {{link_expiration}}.</td></tr><tr><td style="padding:0 36px 32px 36px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#FFF6E5;border-left:4px solid #F5A623;padding:12px 16px;font-size:14px;line-height:1.6;color:#6b4a00;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Only reset your password through the official ValueFarm website.</td></tr></table></td></tr><tr><td style="padding:28px 24px 36px 24px;background:#EEF5FF;text-align:center;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;"><p style="margin:0 0 6px 0;font-size:12px;letter-spacing:2px;color:#0B6BF5;font-weight:bold;">FREE ONLINE SESSION</p><h2 style="margin:0 0 12px 0;font-size:20px;color:#0A1A3F;">ValueFarm Feature Walkthrough</h2><p style="margin:0 0 16px 0;font-size:15px;line-height:1.7;color:#1a2440;">Join our free online session for a live walkthrough of the new ValueFarm features.</p><p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;color:#1a2440;">Monday, 28 September 2026 ｜ 8:00 - 9:00 PM ｜ Online Class</p><p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;color:#1a2440;">Thursday, 1 October 2026 ｜ 8:00 - 9:00 PM ｜ Online Class</p><div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td align="center" bgcolor="#0A1A3F" style="border-radius:8px;"><a href="https://www.grandpine.com/valuefarm-milestone-en/" target="_blank" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">Register Now</a></td></tr></table></td></tr><tr><td style="padding:0 24px;"><div style="height:1px;background:#DCE5F2;"></div></td></tr><tr><td style="padding:10px 36px;background:#0A1A3F;font-family:'Helvetica Neue',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;font-size:12px;letter-spacing:1px;color:#ffffff;text-align:center;">中文</td></tr><tr><td style="padding:0;background:#ffffff;"><img src="https://vf-media-prod-folders.s3.ap-southeast-5.amazonaws.com/edm/Important+Announcement_CN.jpeg" alt="ValueFarm 重要通知：账号安全系统已全面升级" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr><tr><td style="padding:32px 36px 8px 36px;font-family:'Helvetica Neue',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;"><p style="margin:0 0 6px 0;font-size:13px;letter-spacing:1px;color:#0B6BF5;font-weight:bold;">ValueFarm 用户请注意</p><h1 style="margin:0 0 14px 0;font-size:22px;line-height:1.4;color:#0A1A3F;">ValueFarm 账号安全系统已升级</h1><p style="margin:0 0 20px 0;font-size:15px;line-height:1.7;color:#1a2440;">所有用户需要重设密码，才能重新登录 ValueFarm。请按照以下步骤操作：</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:'Helvetica Neue',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;"><tr><td width="36" valign="top" style="padding:0 0 14px 0;"><div style="width:26px;height:26px;line-height:26px;border-radius:13px;background:#0B6BF5;color:#ffffff;text-align:center;font-size:13px;font-weight:bold;">1</div></td><td valign="top" style="padding:3px 0 14px 0;font-size:15px;line-height:1.6;color:#1a2440;">前往官方网站：<a href="https://web.valuefarm.com" style="color:#0B6BF5;font-weight:bold;">https://web.valuefarm.com</a></td></tr><tr><td width="36" valign="top" style="padding:0 0 14px 0;"><div style="width:26px;height:26px;line-height:26px;border-radius:13px;background:#0B6BF5;color:#ffffff;text-align:center;font-size:13px;font-weight:bold;">2</div></td><td valign="top" style="padding:3px 0 14px 0;font-size:15px;line-height:1.6;color:#1a2440;">输入你注册 ValueFarm 时使用的 Email</td></tr><tr><td width="36" valign="top" style="padding:0 0 14px 0;"><div style="width:26px;height:26px;line-height:26px;border-radius:13px;background:#0B6BF5;color:#ffffff;text-align:center;font-size:13px;font-weight:bold;">3</div></td><td valign="top" style="padding:3px 0 14px 0;font-size:15px;line-height:1.6;color:#1a2440;">打开重设密码邮件，按指示设置新密码</td></tr><tr><td width="36" valign="top" style="padding:0 0 14px 0;"><div style="width:26px;height:26px;line-height:26px;border-radius:13px;background:#0B6BF5;color:#ffffff;text-align:center;font-size:13px;font-weight:bold;">4</div></td><td valign="top" style="padding:3px 0 14px 0;font-size:15px;line-height:1.6;color:#1a2440;">返回 ValueFarm Web，使用新密码登录</td></tr></table></td></tr><tr><td align="center" style="padding:16px 36px 12px 36px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td align="center" bgcolor="#0B6BF5" style="border-radius:8px;"><a href="{{link}}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;font-family:'Helvetica Neue',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;">立即重设密码</a></td></tr></table></td></tr><tr><td style="padding:0 36px 20px 36px;text-align:center;font-family:'Helvetica Neue',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;font-size:13px;line-height:1.6;color:#8a93a8;">此链接将在 {{link_expiration}} 后过期。</td></tr><tr><td style="padding:0 36px 32px 36px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#FFF6E5;border-left:4px solid #F5A623;padding:12px 16px;font-size:14px;line-height:1.6;color:#6b4a00;font-family:'Helvetica Neue',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;">请只通过 ValueFarm 官方网站重设密码。</td></tr></table></td></tr><tr><td style="padding:28px 24px 36px 24px;background:#EEF5FF;text-align:center;font-family:'Helvetica Neue',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;"><p style="margin:0 0 6px 0;font-size:12px;letter-spacing:2px;color:#0B6BF5;font-weight:bold;">免费线上分享会</p><h2 style="margin:0 0 12px 0;font-size:20px;color:#0A1A3F;">新版 ValueFarm 功能实操分享</h2><p style="margin:0 0 16px 0;font-size:15px;line-height:1.7;color:#1a2440;">想了解新版 ValueFarm 有哪些功能、该怎么使用？欢迎参加我们的免费线上分享会。</p><p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;color:#1a2440;">9月28日（星期一）晚上 8:00 - 9:00 ｜ 线上举行</p><p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;color:#1a2440;">10月1日（星期四）晚上 8:00 - 9:00 ｜ 线上举行</p><div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td align="center" bgcolor="#0A1A3F" style="border-radius:8px;"><a href="https://www.grandpine.com/valuefarm-milestone/" target="_blank" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;font-family:'Helvetica Neue',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;">立即报名</a></td></tr></table></td></tr><tr><td style="padding:0 24px;"><div style="height:1px;background:#DCE5F2;"></div></td></tr><tr><td style="padding:24px 36px;background:#F7F9FC;text-align:center;font-family:'Helvetica Neue',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;font-size:12px;line-height:1.7;color:#8a93a8;">Official website ｜ 官方网站：<a href="https://web.valuefarm.com" style="color:#0B6BF5;">https://web.valuefarm.com</a></td></tr><tr><td style="padding:0 24px;"><div style="height:1px;background:#DCE5F2;"></div></td></tr><tr><td style="padding:32px 36px 36px 36px;background:#ffffff;font-family:'Helvetica Neue',Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#1a2440;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:0 0 20px 0;"><a href="https://www.grandpine.com/" target="_blank"><img src="https://vf-media-prod-folders.s3.ap-southeast-5.amazonaws.com/edm/GP-logo-2025_1-scaled.png" alt="GrandPine Capital" width="180" style="display:block;width:180px;max-width:100%;height:auto;border:0;"></a></td></tr><tr><td align="center" style="padding:0 0 22px 0;font-size:14px;line-height:1.7;"><strong style="color:#0A1A3F;">Follow us ｜ 关注我们</strong><br><a href="https://www.facebook.com/gpcapital/" style="color:#0B6BF5;text-decoration:none;">Facebook</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="https://www.instagram.com/grandpinecapital/" style="color:#0B6BF5;text-decoration:none;">Instagram</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="https://www.grandpine.com/" style="color:#0B6BF5;text-decoration:none;">Website ｜ 官方网站</a></td></tr><tr><td style="padding:18px 0 0 0;border-top:1px solid #DCE5F2;font-size:13px;line-height:1.7;color:#5f6b82;"><strong style="font-size:15px;color:#0A1A3F;">Contact Us ｜ 联系我们</strong><br>GrandPine Capital Sdn Bhd (623304-K)<br>40-3 &amp; 42-3, Jalan PJU 8/5b, Damansara Perdana, 47820<br>Petaling Jaya, Selangor<br><br>Email: info@grandpine.com<br>Tel ｜ 电话：03-7727 0671</td></tr></table></td></tr></table></td></tr></table>
</body>
</html>$tpl$, false),
('acct-identity-provider-link', 'account_identity_provider_link', 'Link identity provider', 'account', 'html',
 'Link {{identity_provider_name}}',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Link {{identity_provider_name}}</title>
</head>
<body>
<p>Someone wants to link your <b>{{realm_name}}</b> account with <b>{{identity_provider_name}}</b> account of user {{identity_provider_username}}. If this was you, click the link below to link accounts</p><p><a href="{{link}}">Link to confirm account linking</a></p><p>This link will expire within {{link_expiration}}.</p><p>If you don't want to link account, just ignore this message. If you link accounts, you will be able to login to {{realm_name}} through {{identity_provider_name}}.</p>
</body>
</html>$tpl$, false),
('acct-org-invite-personalized', 'account_org_invite_personalized', 'Organization invitation (personalised)', 'account', 'html',
 'Invitation to join the {{organization_name}} organization',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Invitation to join the {{organization_name}} organization</title>
</head>
<body>
<p>Hi, {{first_name}} {{last_name}}.</p><p>You were invited to join the {{organization_name}} organization. Click the link below to join. </p><p><a href="{{link}}">Link to join the organization</a></p><p>This link will expire within {{link_expiration}}.</p><p>If you dont want to join the organization, just ignore this message.</p>
</body>
</html>$tpl$, false),
('acct-org-invite', 'account_org_invite', 'Organization invitation', 'account', 'html',
 'Invitation to join the {{organization_name}} organization',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Invitation to join the {{organization_name}} organization</title>
</head>
<body>
<p>You were invited to join the {{organization_name}} organization. Click the link below to join. </p><p><a href="{{link}}">Link to join the organization</a></p><p>This link will expire within {{link_expiration}}.</p><p>If you dont want to join the organization, just ignore this message.</p>
</body>
</html>$tpl$, false),
('acct-password-reset', 'account_password_reset', 'Reset password', 'account', 'html',
 'Reset password',
$tpl$<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Reset password</title>
</head>
<body>
<p>Someone just requested to change your {{realm_name}} account's credentials. If this was you, click on the link below to reset them.</p><p><a href="{{link}}">Link to reset credentials</a></p><p>This link will expire within {{link_expiration}}.</p><p>If you don't want to reset your credentials, just ignore this message and nothing will be changed.</p>
</body>
</html>$tpl$, false)
ON CONFLICT DO NOTHING;
