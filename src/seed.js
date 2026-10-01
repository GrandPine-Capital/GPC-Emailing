/* Standard templates and example automations, inserted on first start. */
const db = require('./db');
const { renderDesign } = require('./lib/render-blocks');

const b = (type, props = {}) => ({ id: Math.random().toString(36).slice(2, 10), type, props });

const FOOTER = b('footer', {
  html: '<p>{{sender_name}} &middot; {{company_address}}</p><p>You are receiving this because you are a valued contact. <a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
});

const STANDARD = [
  {
    name: 'Monthly Newsletter',
    category: 'newsletter',
    subject: '{{first_name|Hi there}}, your monthly update is here',
    design: {
      settings: { preheader: 'Highlights, insights and what is coming next month.' },
      blocks: [
        b('image', { src: 'https://placehold.co/600x200/1e3a8a/ffffff/png?text=Monthly+Newsletter', alt: 'Newsletter' }),
        b('heading', { text: 'This Month at a Glance', level: 1, align: 'center' }),
        b('text', { html: '<p>Hi {{first_name|there}},</p><p>Here are the most important updates, insights and opportunities we prepared for you this month.</p>' }),
        b('divider'),
        b('heading', { text: '1. Market insight', level: 2 }),
        b('text', { html: '<p>Summarise the key trend your readers should know about in two or three sentences.</p>' }),
        b('heading', { text: '2. Featured article', level: 2 }),
        b('columns', {
          left: '<img src="https://placehold.co/260x160/png?text=Article" width="260" style="width:100%;height:auto;display:block;">',
          right: '<p><strong>Article title</strong></p><p>A short teaser that makes the reader want to click through.</p><p><a href="https://example.com">Read more &rarr;</a></p>',
        }),
        b('heading', { text: '3. Upcoming event', level: 2 }),
        b('text', { html: '<p>Date, time and a one-line description of the event.</p>' }),
        b('button', { text: 'Reserve my seat', href: 'https://example.com/event' }),
        b('social'),
        FOOTER,
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
        b('heading', { text: 'Limited-Time Offer', level: 1, align: 'center', color: '#b45309' }),
        b('image', { src: 'https://placehold.co/600x260/f59e0b/ffffff/png?text=20%25+OFF', alt: 'Offer' }),
        b('text', { html: '<p style="text-align:center">Hi {{first_name|there}}, for a short time we are offering <strong>20% off</strong> for businesses in {{country|your region}}.</p>', align: 'center' }),
        b('button', { text: 'Claim my offer', href: 'https://example.com/offer', bg: '#b45309' }),
        b('text', { html: '<p style="text-align:center;font-size:13px;color:#6b7280">Offer valid until the end of the month.</p>', align: 'center' }),
        FOOTER,
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
        b('heading', { text: 'Welcome, {{first_name|friend}}!', level: 1, align: 'center' }),
        b('text', { html: '<p>Thank you for joining us. Here are three things you can do right now:</p><ol><li>Complete your profile</li><li>Explore our resources</li><li>Reply to this email with any question - a real person reads it.</li></ol>' }),
        b('button', { text: 'Get started', href: 'https://example.com/start' }),
        FOOTER,
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
        b('image', { src: 'https://placehold.co/600x220/0369a1/ffffff/png?text=You+are+invited', alt: 'Event' }),
        b('heading', { text: 'Join our exclusive session', level: 1, align: 'center' }),
        b('text', { html: '<p style="text-align:center"><strong>Date:</strong> Saturday, 10:00 AM<br><strong>Venue:</strong> Online / Kuala Lumpur</p>', align: 'center' }),
        b('text', { html: '<p>Hi {{first_name|there}}, we would love to see you and the {{company|your}} team there. Seats are limited.</p>' }),
        b('button', { text: 'RSVP now', href: 'https://example.com/rsvp', bg: '#0369a1' }),
        FOOTER,
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

function seed() {
  if (db.get('SELECT COUNT(*) n FROM templates').n > 0) return;
  const ids = {};
  for (const t of STANDARD) {
    const mode = t.mode || 'dragdrop';
    const html = mode === 'dragdrop' ? renderDesign(t.design) : t.html;
    const res = db.run(
      'INSERT INTO templates (name, category, mode, subject, design, html, is_standard) VALUES (?, ?, ?, ?, ?, ?, 1)',
      t.name, t.category, mode, t.subject, t.design ? JSON.stringify(t.design) : null, html,
    );
    ids[t.name] = Number(res.lastInsertRowid);
  }

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
  for (const a of automations) {
    db.run(
      "INSERT INTO automations (name, trigger_type, trigger_config, steps, status) VALUES (?, ?, ?, ?, 'paused')",
      a.name, a.trigger_type, JSON.stringify(a.trigger_config), JSON.stringify(a.steps),
    );
  }
}

module.exports = { seed, STANDARD };
