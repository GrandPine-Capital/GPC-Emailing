/* Standard templates and example automations, created by setup(). */
var seedBlock = (type, props = {}) => ({ id: Utilities.getUuid().slice(0, 8), type, props });

var SEED_FOOTER = seedBlock('footer', {
  html: '<p>{{sender_name}} &middot; {{company_address}}</p><p>You are receiving this because you are a valued contact. <a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
});

var STANDARD_TEMPLATES = [
  {
    name: 'Monthly Newsletter',
    category: 'newsletter',
    subject: '{{first_name|Hi there}}, your monthly update is here',
    design: {
      settings: { preheader: 'Highlights, insights and what is coming next month.' },
      blocks: [
        seedBlock('image', { src: 'https://placehold.co/600x200/1e3a8a/ffffff/png?text=Monthly+Newsletter', alt: 'Newsletter' }),
        seedBlock('heading', { text: 'This Month at a Glance', level: 1, align: 'center' }),
        seedBlock('text', { html: '<p>Hi {{first_name|there}},</p><p>Here are the most important updates, insights and opportunities we prepared for you this month.</p>' }),
        seedBlock('divider'),
        seedBlock('heading', { text: '1. Market insight', level: 2 }),
        seedBlock('text', { html: '<p>Summarise the key trend your readers should know about in two or three sentences.</p>' }),
        seedBlock('heading', { text: '2. Featured article', level: 2 }),
        seedBlock('columns', {
          left: '<img src="https://placehold.co/260x160/png?text=Article" width="260" style="width:100%;height:auto;display:block;">',
          right: '<p><strong>Article title</strong></p><p>A short teaser that makes the reader want to click through.</p><p><a href="https://example.com">Read more &rarr;</a></p>',
        }),
        seedBlock('heading', { text: '3. Upcoming event', level: 2 }),
        seedBlock('text', { html: '<p>Date, time and a one-line description of the event.</p>' }),
        seedBlock('button', { text: 'Reserve my seat', href: 'https://example.com/event' }),
        seedBlock('social'),
        SEED_FOOTER,
      ],
    },
  },
  {
    name: 'Promotion / Special Offer',
    category: 'promotion',
    subject: 'Exclusive offer for {{company|you}} - ends soon',
    design: {
      settings: { bgColor: '#fef3c7', preheader: 'A limited-time offer reserved for our contacts.' },
      blocks: [
        seedBlock('heading', { text: 'Limited-Time Offer', level: 1, align: 'center', color: '#b45309' }),
        seedBlock('image', { src: 'https://placehold.co/600x260/f59e0b/ffffff/png?text=20%25+OFF', alt: 'Offer' }),
        seedBlock('text', { html: '<p style="text-align:center">Hi {{first_name|there}}, for a short time we are offering <strong>20% off</strong> for businesses in {{country|your region}}.</p>', align: 'center' }),
        seedBlock('button', { text: 'Claim my offer', href: 'https://example.com/offer', bg: '#b45309' }),
        seedBlock('text', { html: '<p style="text-align:center;font-size:13px;color:#6b7280">Offer valid until the end of the month.</p>', align: 'center' }),
        SEED_FOOTER,
      ],
    },
  },
  {
    name: 'Welcome Email',
    category: 'onboarding',
    subject: 'Welcome aboard, {{first_name|friend}}!',
    design: {
      settings: { preheader: 'Thanks for joining - here is how to get started.' },
      blocks: [
        seedBlock('heading', { text: 'Welcome, {{first_name|friend}}!', level: 1, align: 'center' }),
        seedBlock('text', { html: '<p>Thank you for joining us. Here are three things you can do right now:</p><ol><li>Complete your profile</li><li>Explore our resources</li><li>Reply to this email with any question - a real person reads it.</li></ol>' }),
        seedBlock('button', { text: 'Get started', href: 'https://example.com/start' }),
        SEED_FOOTER,
      ],
    },
  },
  {
    name: 'Event Invitation',
    category: 'event',
    subject: "You're invited: {{first_name|join us}} at our next event",
    design: {
      settings: { contentBg: '#ffffff', bgColor: '#e0f2fe' },
      blocks: [
        seedBlock('image', { src: 'https://placehold.co/600x220/0369a1/ffffff/png?text=You+are+invited', alt: 'Event' }),
        seedBlock('heading', { text: 'Join our exclusive session', level: 1, align: 'center' }),
        seedBlock('text', { html: '<p style="text-align:center"><strong>Date:</strong> Saturday, 10:00 AM<br><strong>Venue:</strong> Online / Kuala Lumpur</p>', align: 'center' }),
        seedBlock('text', { html: '<p>Hi {{first_name|there}}, we would love to see you and the {{company|your}} team there. Seats are limited.</p>' }),
        seedBlock('button', { text: 'RSVP now', href: 'https://example.com/rsvp', bg: '#0369a1' }),
        SEED_FOOTER,
      ],
    },
  },
  {
    name: 'Personal Follow-up (plain)',
    category: 'follow-up',
    mode: 'html',
    subject: 'Quick follow-up, {{first_name|there}}',
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;">
<p>Hi {{first_name|there}},</p>
<p>I wanted to follow up on my previous email in case it got buried. Would it make sense to have a quick 15-minute call this week to see whether we can help {{company|your team}}?</p>
<p>Just reply to this email with a time that works for you.</p>
<p>Best regards,<br>{{sender_name}}</p>
<p style="font-size:12px;color:#888;">If you'd rather not hear from me, <a href="{{unsubscribe_url}}">unsubscribe here</a>.</p>
</body></html>`,
  },
  {
    name: 'Thank You for Your Reply (auto-response)',
    category: 'auto-reply',
    mode: 'html',
    subject: 'Thanks for getting back to us, {{first_name|there}}',
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;">
<p>Hi {{first_name|there}},</p>
<p>Thank you for your reply! A member of our team has been notified and will get back to you within one business day.</p>
<p>Warm regards,<br>{{sender_name}}</p>
<p style="font-size:12px;color:#888;"><a href="{{unsubscribe_url}}">Unsubscribe</a></p>
</body></html>`,
  },
];

function seedContent() {
  if (FS.query('templates', { limit: 1 }).length) return { templates: 0, automations: 0 };
  const ids = {};
  const now = nowIso();
  STANDARD_TEMPLATES.forEach(function (t) {
    const mode = t.mode || 'dragdrop';
    const doc = FS.create('templates', {
      name: t.name, category: t.category, mode: mode, subject: t.subject,
      design: t.design || null,
      html: mode === 'dragdrop' ? EmailRender.renderDesign(t.design) : t.html,
      is_standard: true, created_at: now, updated_at: now,
    });
    ids[t.name] = doc.id;
  });

  const automations = [
    {
      name: 'Follow up if no reply after 3 days',
      trigger_type: 'email_sent',
      trigger_config: { stop_on_reply: true },
      steps: [
        { type: 'wait', amount: 3, unit: 'days' },
        { type: 'stop_if', condition: 'replied' },
        { type: 'send_email', template_id: ids['Personal Follow-up (plain)'], reply_in_thread: true },
        { type: 'wait', amount: 4, unit: 'days' },
        { type: 'stop_if', condition: 'replied' },
        { type: 'add_tag', tag: 'no-response' },
      ],
    },
    {
      name: 'Auto-respond & notify team on reply',
      trigger_type: 'reply_received',
      trigger_config: {},
      steps: [
        { type: 'add_tag', tag: 'replied' },
        { type: 'send_email', template_id: ids['Thank You for Your Reply (auto-response)'], reply_in_thread: true },
        { type: 'notify', email: '' },
      ],
    },
    {
      name: 'Hot lead: interested reply',
      trigger_type: 'reply_received',
      trigger_config: { keywords: 'interested, pricing, price, quote, call, meeting' },
      steps: [
        { type: 'add_tag', tag: 'hot-lead' },
        { type: 'notify', email: '', subject: 'Hot lead replied!' },
      ],
    },
    {
      name: 'Welcome new subscribers',
      trigger_type: 'contact_added',
      trigger_config: {},
      steps: [{ type: 'send_email', template_id: ids['Welcome Email'] }],
    },
  ];
  automations.forEach(function (a) {
    FS.create('automations', Object.assign({ status: 'paused', allow_reentry: false, runs: {}, created_at: now }, a));
  });
  return { templates: STANDARD_TEMPLATES.length, automations: automations.length };
}
