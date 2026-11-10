-- Standard templates and example automations (paused), as setup() created them in the
-- Firebase build. Generated once from apps-script/Seed.js; edit them in the dashboard.

INSERT INTO templates (id, name, category, mode, subject, design, html, is_standard) VALUES ('std-monthly-newsletter', 'Monthly Newsletter', 'newsletter', 'dragdrop', '{{first_name|Hi there}}, your monthly update is here', '{"settings":{"preheader":"Highlights, insights and what is coming next month."},"blocks":[{"id":"seed0002","type":"image","props":{"src":"https://placehold.co/600x200/1e3a8a/ffffff/png?text=Monthly+Newsletter","alt":"Newsletter"}},{"id":"seed0003","type":"heading","props":{"text":"This Month at a Glance","level":1,"align":"center"}},{"id":"seed0004","type":"text","props":{"html":"<p>Hi {{first_name|there}},</p><p>Here are the most important updates, insights and opportunities we prepared for you this month.</p>"}},{"id":"seed0005","type":"divider","props":{}},{"id":"seed0006","type":"heading","props":{"text":"1. Market insight","level":2}},{"id":"seed0007","type":"text","props":{"html":"<p>Summarise the key trend your readers should know about in two or three sentences.</p>"}},{"id":"seed0008","type":"heading","props":{"text":"2. Featured article","level":2}},{"id":"seed0009","type":"columns","props":{"left":"<img src=\"https://placehold.co/260x160/png?text=Article\" width=\"260\" style=\"width:100%;height:auto;display:block;\">","right":"<p><strong>Article title</strong></p><p>A short teaser that makes the reader want to click through.</p><p><a href=\"https://example.com\">Read more &rarr;</a></p>"}},{"id":"seed0010","type":"heading","props":{"text":"3. Upcoming event","level":2}},{"id":"seed0011","type":"text","props":{"html":"<p>Date, time and a one-line description of the event.</p>"}},{"id":"seed0012","type":"button","props":{"text":"Reserve my seat","href":"https://example.com/event"}},{"id":"seed0013","type":"social","props":{}},{"id":"seed0001","type":"footer","props":{"html":"<p>{{sender_name}} &middot; {{company_address}}</p><p>You are receiving this because you are a valued contact. <a href=\"{{unsubscribe_url}}\">Unsubscribe</a></p>"}}]}'::jsonb, '<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title></title>
<style>
  a { color: #2563eb; }
  p { margin: 0 0 12px; }
  @media only screen and (max-width: 620px) {
    .container { width: 100% !important; }
    .col { display: block !important; width: 100% !important; padding: 0 0 12px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Highlights, insights and what is coming next month.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:24px 8px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="text-align:center;"><img src="https://placehold.co/600x200/1e3a8a/ffffff/png?text=Monthly+Newsletter" alt="Newsletter" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;margin:0 auto;"></td></tr>
<tr><td style="padding:16px 24px;"><h1 style="margin:0;font-size:28px;line-height:1.3;color:#333333;text-align:center;font-family:Arial, Helvetica, sans-serif;">This Month at a Glance</h1></td></tr>
<tr><td style="padding:16px 24px;"><div style="font-size:15px;line-height:1.6;color:#333333;text-align:left;font-family:Arial, Helvetica, sans-serif;"><p>Hi {{first_name|there}},</p><p>Here are the most important updates, insights and opportunities we prepared for you this month.</p></div></td></tr>
<tr><td style="padding:16px 24px;"><div style="border-top:1px solid #e5e7eb;font-size:0;line-height:0;">&nbsp;</div></td></tr>
<tr><td style="padding:16px 24px;"><h2 style="margin:0;font-size:22px;line-height:1.3;color:#333333;text-align:left;font-family:Arial, Helvetica, sans-serif;">1. Market insight</h2></td></tr>
<tr><td style="padding:16px 24px;"><div style="font-size:15px;line-height:1.6;color:#333333;text-align:left;font-family:Arial, Helvetica, sans-serif;"><p>Summarise the key trend your readers should know about in two or three sentences.</p></div></td></tr>
<tr><td style="padding:16px 24px;"><h2 style="margin:0;font-size:22px;line-height:1.3;color:#333333;text-align:left;font-family:Arial, Helvetica, sans-serif;">2. Featured article</h2></td></tr>
<tr><td style="padding:16px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="col" width="50%" valign="top" style="padding:0 8px;font-size:15px;line-height:1.6;color:#333333;font-family:Arial, Helvetica, sans-serif;"><img src="https://placehold.co/260x160/png?text=Article" width="260" style="width:100%;height:auto;display:block;"></td><td class="col" width="50%" valign="top" style="padding:0 8px;font-size:15px;line-height:1.6;color:#333333;font-family:Arial, Helvetica, sans-serif;"><p><strong>Article title</strong></p><p>A short teaser that makes the reader want to click through.</p><p><a href="https://example.com">Read more &rarr;</a></p></td></tr></table></td></tr>
<tr><td style="padding:16px 24px;"><h2 style="margin:0;font-size:22px;line-height:1.3;color:#333333;text-align:left;font-family:Arial, Helvetica, sans-serif;">3. Upcoming event</h2></td></tr>
<tr><td style="padding:16px 24px;"><div style="font-size:15px;line-height:1.6;color:#333333;text-align:left;font-family:Arial, Helvetica, sans-serif;"><p>Date, time and a one-line description of the event.</p></div></td></tr>
<tr><td style="padding:16px 24px;text-align:center;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr><td style="background:#2563eb;border-radius:6px;"><a href="https://example.com/event" target="_blank" style="display:inline-block;padding:12px 28px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;font-family:Arial, Helvetica, sans-serif;border-radius:6px;">Reserve my seat</a></td></tr></table></td></tr>
<tr><td style="padding:16px 24px;text-align:center;"><a href="https://facebook.com" target="_blank" style="display:inline-block;margin:0 6px;padding:6px 12px;background:#111827;color:#ffffff;border-radius:4px;text-decoration:none;font-size:13px;font-family:Arial, Helvetica, sans-serif;">Facebook</a><a href="https://linkedin.com" target="_blank" style="display:inline-block;margin:0 6px;padding:6px 12px;background:#111827;color:#ffffff;border-radius:4px;text-decoration:none;font-size:13px;font-family:Arial, Helvetica, sans-serif;">LinkedIn</a></td></tr>
<tr><td style="padding:16px 24px;"><div style="font-size:12px;line-height:1.5;color:#6b7280;text-align:center;font-family:Arial, Helvetica, sans-serif;"><p>{{sender_name}} &middot; {{company_address}}</p><p>You are receiving this because you are a valued contact. <a href="{{unsubscribe_url}}">Unsubscribe</a></p></div></td></tr>
</table>
</td></tr>
</table>
</body>
</html>', true);

INSERT INTO templates (id, name, category, mode, subject, design, html, is_standard) VALUES ('std-promotion-special-offer', 'Promotion / Special Offer', 'promotion', 'dragdrop', 'Exclusive offer for {{company|you}} - ends soon', '{"settings":{"bgColor":"#fef3c7","preheader":"A limited-time offer reserved for our contacts."},"blocks":[{"id":"seed0014","type":"heading","props":{"text":"Limited-Time Offer","level":1,"align":"center","color":"#b45309"}},{"id":"seed0015","type":"image","props":{"src":"https://placehold.co/600x260/f59e0b/ffffff/png?text=20%25+OFF","alt":"Offer"}},{"id":"seed0016","type":"text","props":{"html":"<p style=\"text-align:center\">Hi {{first_name|there}}, for a short time we are offering <strong>20% off</strong> for businesses in {{country|your region}}.</p>","align":"center"}},{"id":"seed0017","type":"button","props":{"text":"Claim my offer","href":"https://example.com/offer","bg":"#b45309"}},{"id":"seed0018","type":"text","props":{"html":"<p style=\"text-align:center;font-size:13px;color:#6b7280\">Offer valid until the end of the month.</p>","align":"center"}},{"id":"seed0001","type":"footer","props":{"html":"<p>{{sender_name}} &middot; {{company_address}}</p><p>You are receiving this because you are a valued contact. <a href=\"{{unsubscribe_url}}\">Unsubscribe</a></p>"}}]}'::jsonb, '<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title></title>
<style>
  a { color: #2563eb; }
  p { margin: 0 0 12px; }
  @media only screen and (max-width: 620px) {
    .container { width: 100% !important; }
    .col { display: block !important; width: 100% !important; padding: 0 0 12px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#fef3c7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">A limited-time offer reserved for our contacts.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fef3c7;">
<tr><td align="center" style="padding:24px 8px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="padding:16px 24px;"><h1 style="margin:0;font-size:28px;line-height:1.3;color:#b45309;text-align:center;font-family:Arial, Helvetica, sans-serif;">Limited-Time Offer</h1></td></tr>
<tr><td style="text-align:center;"><img src="https://placehold.co/600x260/f59e0b/ffffff/png?text=20%25+OFF" alt="Offer" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;margin:0 auto;"></td></tr>
<tr><td style="padding:16px 24px;"><div style="font-size:15px;line-height:1.6;color:#333333;text-align:center;font-family:Arial, Helvetica, sans-serif;"><p style="text-align:center">Hi {{first_name|there}}, for a short time we are offering <strong>20% off</strong> for businesses in {{country|your region}}.</p></div></td></tr>
<tr><td style="padding:16px 24px;text-align:center;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr><td style="background:#b45309;border-radius:6px;"><a href="https://example.com/offer" target="_blank" style="display:inline-block;padding:12px 28px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;font-family:Arial, Helvetica, sans-serif;border-radius:6px;">Claim my offer</a></td></tr></table></td></tr>
<tr><td style="padding:16px 24px;"><div style="font-size:15px;line-height:1.6;color:#333333;text-align:center;font-family:Arial, Helvetica, sans-serif;"><p style="text-align:center;font-size:13px;color:#6b7280">Offer valid until the end of the month.</p></div></td></tr>
<tr><td style="padding:16px 24px;"><div style="font-size:12px;line-height:1.5;color:#6b7280;text-align:center;font-family:Arial, Helvetica, sans-serif;"><p>{{sender_name}} &middot; {{company_address}}</p><p>You are receiving this because you are a valued contact. <a href="{{unsubscribe_url}}">Unsubscribe</a></p></div></td></tr>
</table>
</td></tr>
</table>
</body>
</html>', true);

INSERT INTO templates (id, name, category, mode, subject, design, html, is_standard) VALUES ('std-welcome-email', 'Welcome Email', 'onboarding', 'dragdrop', 'Welcome aboard, {{first_name|friend}}!', '{"settings":{"preheader":"Thanks for joining - here is how to get started."},"blocks":[{"id":"seed0019","type":"heading","props":{"text":"Welcome, {{first_name|friend}}!","level":1,"align":"center"}},{"id":"seed0020","type":"text","props":{"html":"<p>Thank you for joining us. Here are three things you can do right now:</p><ol><li>Complete your profile</li><li>Explore our resources</li><li>Reply to this email with any question - a real person reads it.</li></ol>"}},{"id":"seed0021","type":"button","props":{"text":"Get started","href":"https://example.com/start"}},{"id":"seed0001","type":"footer","props":{"html":"<p>{{sender_name}} &middot; {{company_address}}</p><p>You are receiving this because you are a valued contact. <a href=\"{{unsubscribe_url}}\">Unsubscribe</a></p>"}}]}'::jsonb, '<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title></title>
<style>
  a { color: #2563eb; }
  p { margin: 0 0 12px; }
  @media only screen and (max-width: 620px) {
    .container { width: 100% !important; }
    .col { display: block !important; width: 100% !important; padding: 0 0 12px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Thanks for joining - here is how to get started.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:24px 8px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="padding:16px 24px;"><h1 style="margin:0;font-size:28px;line-height:1.3;color:#333333;text-align:center;font-family:Arial, Helvetica, sans-serif;">Welcome, {{first_name|friend}}!</h1></td></tr>
<tr><td style="padding:16px 24px;"><div style="font-size:15px;line-height:1.6;color:#333333;text-align:left;font-family:Arial, Helvetica, sans-serif;"><p>Thank you for joining us. Here are three things you can do right now:</p><ol><li>Complete your profile</li><li>Explore our resources</li><li>Reply to this email with any question - a real person reads it.</li></ol></div></td></tr>
<tr><td style="padding:16px 24px;text-align:center;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr><td style="background:#2563eb;border-radius:6px;"><a href="https://example.com/start" target="_blank" style="display:inline-block;padding:12px 28px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;font-family:Arial, Helvetica, sans-serif;border-radius:6px;">Get started</a></td></tr></table></td></tr>
<tr><td style="padding:16px 24px;"><div style="font-size:12px;line-height:1.5;color:#6b7280;text-align:center;font-family:Arial, Helvetica, sans-serif;"><p>{{sender_name}} &middot; {{company_address}}</p><p>You are receiving this because you are a valued contact. <a href="{{unsubscribe_url}}">Unsubscribe</a></p></div></td></tr>
</table>
</td></tr>
</table>
</body>
</html>', true);

INSERT INTO templates (id, name, category, mode, subject, design, html, is_standard) VALUES ('std-event-invitation', 'Event Invitation', 'event', 'dragdrop', 'You''re invited: {{first_name|join us}} at our next event', '{"settings":{"contentBg":"#ffffff","bgColor":"#e0f2fe"},"blocks":[{"id":"seed0022","type":"image","props":{"src":"https://placehold.co/600x220/0369a1/ffffff/png?text=You+are+invited","alt":"Event"}},{"id":"seed0023","type":"heading","props":{"text":"Join our exclusive session","level":1,"align":"center"}},{"id":"seed0024","type":"text","props":{"html":"<p style=\"text-align:center\"><strong>Date:</strong> Saturday, 10:00 AM<br><strong>Venue:</strong> Online / Kuala Lumpur</p>","align":"center"}},{"id":"seed0025","type":"text","props":{"html":"<p>Hi {{first_name|there}}, we would love to see you and the {{company|your}} team there. Seats are limited.</p>"}},{"id":"seed0026","type":"button","props":{"text":"RSVP now","href":"https://example.com/rsvp","bg":"#0369a1"}},{"id":"seed0001","type":"footer","props":{"html":"<p>{{sender_name}} &middot; {{company_address}}</p><p>You are receiving this because you are a valued contact. <a href=\"{{unsubscribe_url}}\">Unsubscribe</a></p>"}}]}'::jsonb, '<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title></title>
<style>
  a { color: #2563eb; }
  p { margin: 0 0 12px; }
  @media only screen and (max-width: 620px) {
    .container { width: 100% !important; }
    .col { display: block !important; width: 100% !important; padding: 0 0 12px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#e0f2fe;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e0f2fe;">
<tr><td align="center" style="padding:24px 8px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="text-align:center;"><img src="https://placehold.co/600x220/0369a1/ffffff/png?text=You+are+invited" alt="Event" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;margin:0 auto;"></td></tr>
<tr><td style="padding:16px 24px;"><h1 style="margin:0;font-size:28px;line-height:1.3;color:#333333;text-align:center;font-family:Arial, Helvetica, sans-serif;">Join our exclusive session</h1></td></tr>
<tr><td style="padding:16px 24px;"><div style="font-size:15px;line-height:1.6;color:#333333;text-align:center;font-family:Arial, Helvetica, sans-serif;"><p style="text-align:center"><strong>Date:</strong> Saturday, 10:00 AM<br><strong>Venue:</strong> Online / Kuala Lumpur</p></div></td></tr>
<tr><td style="padding:16px 24px;"><div style="font-size:15px;line-height:1.6;color:#333333;text-align:left;font-family:Arial, Helvetica, sans-serif;"><p>Hi {{first_name|there}}, we would love to see you and the {{company|your}} team there. Seats are limited.</p></div></td></tr>
<tr><td style="padding:16px 24px;text-align:center;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr><td style="background:#0369a1;border-radius:6px;"><a href="https://example.com/rsvp" target="_blank" style="display:inline-block;padding:12px 28px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;font-family:Arial, Helvetica, sans-serif;border-radius:6px;">RSVP now</a></td></tr></table></td></tr>
<tr><td style="padding:16px 24px;"><div style="font-size:12px;line-height:1.5;color:#6b7280;text-align:center;font-family:Arial, Helvetica, sans-serif;"><p>{{sender_name}} &middot; {{company_address}}</p><p>You are receiving this because you are a valued contact. <a href="{{unsubscribe_url}}">Unsubscribe</a></p></div></td></tr>
</table>
</td></tr>
</table>
</body>
</html>', true);

INSERT INTO templates (id, name, category, mode, subject, design, html, is_standard) VALUES ('std-personal-follow-up-plain', 'Personal Follow-up (plain)', 'follow-up', 'html', 'Quick follow-up, {{first_name|there}}', NULL, '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;">
<p>Hi {{first_name|there}},</p>
<p>I wanted to follow up on my previous email in case it got buried. Would it make sense to have a quick 15-minute call this week to see whether we can help {{company|your team}}?</p>
<p>Just reply to this email with a time that works for you.</p>
<p>Best regards,<br>{{sender_name}}</p>
<p style="font-size:12px;color:#888;">If you''d rather not hear from me, <a href="{{unsubscribe_url}}">unsubscribe here</a>.</p>
</body></html>', true);

INSERT INTO templates (id, name, category, mode, subject, design, html, is_standard) VALUES ('std-thank-you-for-your-reply-auto-response', 'Thank You for Your Reply (auto-response)', 'auto-reply', 'html', 'Thanks for getting back to us, {{first_name|there}}', NULL, '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;">
<p>Hi {{first_name|there}},</p>
<p>Thank you for your reply! A member of our team has been notified and will get back to you within one business day.</p>
<p>Warm regards,<br>{{sender_name}}</p>
<p style="font-size:12px;color:#888;"><a href="{{unsubscribe_url}}">Unsubscribe</a></p>
</body></html>', true);

INSERT INTO automations (id, name, trigger_type, trigger_config, steps, status) VALUES ('std-follow-up', 'Follow up if no reply after 3 days', 'email_sent', '{"stop_on_reply":true}'::jsonb, '[{"type":"wait","amount":3,"unit":"days"},{"type":"stop_if","condition":"replied"},{"type":"send_email","template_id":"std-personal-follow-up-plain","reply_in_thread":true},{"type":"wait","amount":4,"unit":"days"},{"type":"stop_if","condition":"replied"},{"type":"add_tag","tag":"no-response"}]'::jsonb, 'paused');
INSERT INTO automations (id, name, trigger_type, trigger_config, steps, status) VALUES ('std-auto-respond', 'Auto-respond & notify team on reply', 'reply_received', '{}'::jsonb, '[{"type":"add_tag","tag":"replied"},{"type":"send_email","template_id":"std-thank-you-for-your-reply-auto-response","reply_in_thread":true},{"type":"notify","email":""}]'::jsonb, 'paused');
INSERT INTO automations (id, name, trigger_type, trigger_config, steps, status) VALUES ('std-hot-lead', 'Hot lead: interested reply', 'reply_received', '{"keywords":"interested, pricing, price, quote, call, meeting"}'::jsonb, '[{"type":"add_tag","tag":"hot-lead"},{"type":"notify","email":"","subject":"Hot lead replied!"}]'::jsonb, 'paused');
INSERT INTO automations (id, name, trigger_type, trigger_config, steps, status) VALUES ('std-welcome', 'Welcome new subscribers', 'contact_added', '{}'::jsonb, '[{"type":"send_email","template_id":"std-welcome-email"}]'::jsonb, 'paused');
