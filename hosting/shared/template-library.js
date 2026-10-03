// GENERATED from shared/ by scripts/sync-shared.js - edit the file in shared/ instead.
/*
 * Ready-made email templates by industry (window.EmailTemplateLibrary).
 * "Use template" in the dashboard copies one into your Templates, where it
 * can be edited with the drag & drop builder or as HTML.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmailTemplateLibrary = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  let n = 0;
  const b = function (type, props) { n++; return { id: 'lib' + n, type: type, props: props || {} }; };
  const img = function (bg, text) {
    return 'https://placehold.co/600x240/' + bg + '/ffffff/png?text=' + encodeURIComponent(text).replace(/%20/g, '+');
  };
  const footer = function () {
    return b('footer', { html: '<p>{{sender_name}} &middot; {{company_address}}</p><p>You are receiving this email because you are a valued contact. <a href="{{unsubscribe_url}}">Unsubscribe</a></p>' });
  };
  const plain = function (paragraphs) {
    return '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;">' +
      paragraphs.map(function (p) { return '<p>' + p + '</p>'; }).join('\n') + '</body></html>';
  };

  const T = [
    // ------------------------------------------------------------ education
    {
      key: 'edu-enrolment', industry: 'Education', category: 'promotion',
      name: 'Education - Course enrolment now open',
      subject: '{{first_name|Hi there}}, enrolment for our new intake is open',
      design: { settings: { bgColor: '#eef4ff', preheader: 'Limited seats for the new intake - early-bird pricing this week only.' }, blocks: [
        b('image', { src: img('1d4ed8', 'New Intake Now Open'), alt: 'New intake' }),
        b('heading', { text: 'Enrolment is now open', level: 1, align: 'center' }),
        b('text', { html: '<p>Hi {{first_name|there}},</p><p>Our next intake starts soon and seats are limited. Join a programme designed by experienced educators, with small classes, practical projects and a certificate on completion.</p>' }),
        b('columns', { left: '<p><strong>What you will gain</strong></p><ul><li>Structured, step-by-step lessons</li><li>Personal coaching &amp; feedback</li><li>Recognised certificate</li></ul>', right: '<p><strong>Programme details</strong></p><ul><li>Duration: 8 weeks</li><li>Online + physical classes</li><li>Early-bird: 20% off this week</li></ul>' }),
        b('button', { text: 'Reserve my seat', href: 'https://example.com/enrol', bg: '#1d4ed8' }),
        b('text', { html: '<p style="text-align:center;font-size:13px;color:#6b7280">Questions? Simply reply to this email - we read every message.</p>', align: 'center' }),
        footer(),
      ] },
    },
    {
      key: 'edu-open-day', industry: 'Education', category: 'event',
      name: 'Education - Free trial class / open day',
      subject: 'You\'re invited: free trial class this weekend',
      design: { settings: { bgColor: '#fff7ed', preheader: 'See our teaching approach first-hand - no obligation.' }, blocks: [
        b('heading', { text: 'Join a free trial class', level: 1, align: 'center', color: '#c2410c' }),
        b('text', { html: '<p>Hi {{first_name|there}},</p><p>The best way to know if a learning centre is right for you or your child is to experience it. Join our <strong>free trial class</strong> and meet our teachers.</p><p><strong>Date:</strong> Saturday, 10:00 AM<br><strong>Location:</strong> Our centre / online</p>' }),
        b('button', { text: 'Book a free trial', href: 'https://example.com/trial', bg: '#ea580c' }),
        footer(),
      ] },
    },
    // ------------------------------------------------------------ investment
    {
      key: 'inv-webinar', industry: 'Investment Education', category: 'event',
      name: 'Investment Education - Free investing webinar',
      subject: '{{first_name|Hi}}, learn how to invest with confidence (free webinar)',
      design: { settings: { bgColor: '#ecfdf5', preheader: 'A practical 60-minute session - live Q&A included.' }, blocks: [
        b('image', { src: img('047857', 'Free Investing Webinar'), alt: 'Investing webinar' }),
        b('heading', { text: 'Invest with a clear system, not guesswork', level: 1, align: 'center' }),
        b('text', { html: '<p>Hi {{first_name|there}},</p><p>Join our free live webinar to learn the framework our students use to pick quality companies, manage risk and build long-term wealth.</p><ul><li>How to read a company\'s fundamentals in 10 minutes</li><li>The 3 mistakes most new investors make</li><li>Building a portfolio that lets you sleep at night</li></ul>' }),
        b('button', { text: 'Save my free seat', href: 'https://example.com/webinar', bg: '#047857' }),
        b('text', { html: '<p style="font-size:12px;color:#6b7280">This session is for educational purposes only and is not financial advice.</p>' }),
        footer(),
      ] },
    },
    {
      key: 'inv-tool-trial', industry: 'Investment Tools', category: 'promotion',
      name: 'Investment Tools - Free trial of our investing tool',
      subject: 'Try our investing tool free for 14 days',
      design: { settings: { bgColor: '#f1f5f9', preheader: 'Screen stocks, track your portfolio and get alerts - free for 14 days.' }, blocks: [
        b('heading', { text: 'Make smarter investing decisions in minutes', level: 1, align: 'center' }),
        b('image', { src: img('0f172a', 'Stock Screener + Portfolio Tracker'), alt: 'Investment tool' }),
        b('columns', { left: '<p><strong>Stock screener</strong><br>Filter by valuation, growth and dividends.</p><p><strong>Smart alerts</strong><br>Get notified when your targets are hit.</p>', right: '<p><strong>Portfolio tracker</strong><br>All your holdings and returns in one view.</p><p><strong>Learning hub</strong><br>Guides and videos built in.</p>' }),
        b('button', { text: 'Start my free trial', href: 'https://example.com/trial', bg: '#2563eb' }),
        footer(),
      ] },
    },
    {
      key: 'inv-newsletter', industry: 'Investment Education', category: 'newsletter',
      name: 'Investment - Weekly market insights newsletter',
      subject: 'This week in the markets: 3 things to know',
      design: { settings: { preheader: 'Market recap, one stock idea to study, and one lesson.' }, blocks: [
        b('heading', { text: 'Weekly Market Insights', level: 1 }),
        b('text', { html: '<p>Hi {{first_name|there}}, here is your 3-minute weekly briefing.</p>' }),
        b('heading', { text: '1. Market recap', level: 2 }), b('text', { html: '<p>Summarise the week\'s key market moves and what drove them.</p>' }),
        b('heading', { text: '2. A company worth studying', level: 2 }), b('text', { html: '<p>Introduce one company and why its business model is interesting.</p>' }),
        b('heading', { text: '3. Lesson of the week', level: 2 }), b('text', { html: '<p>One practical investing principle with a simple example.</p>' }),
        b('button', { text: 'Read the full analysis', href: 'https://example.com/blog' }),
        b('text', { html: '<p style="font-size:12px;color:#6b7280">Educational content only - not financial advice.</p>' }),
        footer(),
      ] },
    },
    // ------------------------------------------------------------ dental
    {
      key: 'dental-lab-outreach', industry: 'Dental Lab', category: 'outreach',
      name: 'Dental Lab - Partnership introduction to clinics',
      subject: 'Faster, precise restorations for {{company|your clinic}}',
      design: { settings: { bgColor: '#f0f9ff', preheader: 'Digital workflow, quick turnaround and consistent quality.' }, blocks: [
        b('heading', { text: 'Your reliable dental lab partner', level: 1 }),
        b('text', { html: '<p>Dear Dr {{last_name|}},</p><p>We are a dental laboratory supporting clinics with crowns, bridges, veneers, implant restorations and clear aligners. We would love to support {{company|your clinic}}.</p>' }),
        b('columns', { left: '<ul><li>Digital scans accepted (STL)</li><li>CAD/CAM zirconia &amp; e.max</li><li>Implant abutments &amp; bars</li></ul>', right: '<ul><li>Turnaround from 3 working days</li><li>Free pickup &amp; delivery</li><li>Remake guarantee</li></ul>' }),
        b('button', { text: 'Request a price list & free sample case', href: 'https://example.com/dental-lab', bg: '#0369a1' }),
        b('text', { html: '<p>Happy to drop by your clinic for a short introduction - just reply with a convenient time.</p><p>Best regards,<br>{{sender_name}}</p>' }),
        footer(),
      ] },
    },
    {
      key: 'dental-clinic-checkup', industry: 'Dental Clinics', category: 'promotion',
      name: 'Dental Clinic - Check-up reminder & offer',
      subject: '{{first_name|Hi}}, time for your dental check-up?',
      design: { settings: { bgColor: '#f0fdfa', preheader: 'Book a scaling & polishing session this month.' }, blocks: [
        b('image', { src: img('0d9488', 'Healthy Smile Check-up'), alt: 'Dental check-up' }),
        b('heading', { text: 'Keep your smile healthy', level: 1, align: 'center' }),
        b('text', { html: '<p>Hi {{first_name|there}},</p><p>Regular check-ups every 6 months help prevent cavities and gum problems before they start. Book this month and enjoy a complimentary oral health assessment.</p>' }),
        b('button', { text: 'Book my appointment', href: 'https://example.com/book', bg: '#0d9488' }),
        footer(),
      ] },
    },
    // ------------------------------------------------------------ soul, mind & numerology
    {
      key: 'numerology-workshop', industry: 'Numerology Education', category: 'event',
      name: 'Numerology - Discover your numbers workshop',
      subject: 'What do your numbers say about you, {{first_name|friend}}?',
      design: { settings: { bgColor: '#faf5ff', preheader: 'A beginner-friendly numerology workshop - learn to read your own chart.' }, blocks: [
        b('image', { src: img('7c3aed', 'Discover Your Numbers'), alt: 'Numerology workshop' }),
        b('heading', { text: 'Discover the meaning of your numbers', level: 1, align: 'center', color: '#6d28d9' }),
        b('text', { html: '<p>Hi {{first_name|there}},</p><p>Your date of birth holds patterns that reveal your strengths, challenges and natural talents. In this beginner-friendly workshop you will learn to read your own numerology chart.</p><ul><li>Your life path &amp; personality numbers</li><li>Strengths and missing numbers</li><li>Using numerology for career and relationships</li></ul>' }),
        b('button', { text: 'Join the workshop', href: 'https://example.com/numerology', bg: '#7c3aed' }),
        footer(),
      ] },
    },
    {
      key: 'soul-mind-retreat', industry: 'Soul & Mind Education', category: 'event',
      name: 'Soul & Mind - Mindfulness & inner peace programme',
      subject: 'A calmer mind starts here, {{first_name|friend}}',
      design: { settings: { bgColor: '#f5f5f4', textColor: '#292524', preheader: 'Reconnect with yourself in our soul & mind programme.' }, blocks: [
        b('image', { src: img('57534e', 'Soul and Mind Programme'), alt: 'Soul & mind' }),
        b('heading', { text: 'Find clarity, balance and inner peace', level: 1, align: 'center' }),
        b('text', { html: '<p>Hi {{first_name|there}},</p><p>Life moves fast. Our soul &amp; mind programme gives you practical tools - mindfulness, breathwork and guided reflection - to reduce stress and live with more intention.</p>' }),
        b('button', { text: 'Learn more about the programme', href: 'https://example.com/soul-mind', bg: '#57534e' }),
        footer(),
      ] },
    },
    // ------------------------------------------------------------ personal & talent development
    {
      key: 'personal-dev-launch', industry: 'Personal Development Education', category: 'promotion',
      name: 'Personal Development - Unlock your potential programme',
      subject: '{{first_name|Hi}}, ready to unlock your full potential?',
      design: { settings: { bgColor: '#fefce8', preheader: 'A practical programme for confidence, focus and growth.' }, blocks: [
        b('heading', { text: 'Unlock your full potential', level: 1, align: 'center', color: '#a16207' }),
        b('text', { html: '<p>Hi {{first_name|there}},</p><p>Whether you want more confidence, better habits or a clear direction for your career, our personal development programme gives you a proven step-by-step path.</p>' }),
        b('columns', { left: '<p><strong>You will learn to</strong></p><ul><li>Set and achieve meaningful goals</li><li>Build lasting habits</li></ul>', right: '<p><strong>Format</strong></p><ul><li>6 live coaching sessions</li><li>Workbook &amp; community</li></ul>' }),
        b('button', { text: 'Start my journey', href: 'https://example.com/programme', bg: '#ca8a04' }),
        footer(),
      ] },
    },
    {
      key: 'talent-corporate', industry: 'Human Development & Talent Management', category: 'outreach',
      name: 'Talent Management - Corporate training proposal (B2B)',
      subject: 'Developing the people behind {{company|your company}}',
      design: { settings: { preheader: 'Leadership, talent development and HR consulting programmes for your team.' }, blocks: [
        b('heading', { text: 'Grow your people, grow your business', level: 1 }),
        b('text', { html: '<p>Dear {{first_name|HR team}},</p><p>We help organisations like {{company|yours}} attract, develop and retain talent through practical training and human capital consulting.</p>' }),
        b('columns', { left: '<ul><li>Leadership &amp; management programmes</li><li>Talent assessment &amp; succession planning</li></ul>', right: '<ul><li>Soft skills &amp; communication workshops</li><li>Training grant (e.g. HRD Corp) claimable courses</li></ul>' }),
        b('button', { text: 'Book a free consultation', href: 'https://example.com/consult' }),
        b('text', { html: '<p>Best regards,<br>{{sender_name}}</p>' }),
        footer(),
      ] },
    },
    {
      key: 'b2b-plain-intro', industry: 'Any industry', category: 'outreach', mode: 'html',
      name: 'Personal B2B introduction (plain, high deliverability)',
      subject: 'Quick question, {{first_name|there}}',
      html: plain([
        'Hi {{first_name|there}},',
        'I came across {{company|your company}} and noticed you work in {{industry|your industry}}. We help similar organisations in {{country|your region}} save time and grow - and I thought it might be relevant.',
        'Would you be open to a short 15-minute call next week to see if it is a fit?',
        'Best regards,<br>{{sender_name}}',
        '<span style="font-size:12px;color:#888">Not relevant? <a href="{{unsubscribe_url}}">Let me know</a> and I won\'t email again.</span>',
      ]),
    },
    // ------------------------------------------------------------ auto-replies
    {
      key: 'auto-thanks', industry: 'Auto-reply', category: 'auto-reply', mode: 'html',
      name: 'Auto-reply - Thanks for contacting us',
      subject: 'We received your message',
      html: plain([
        'Hi {{first_name|there}},',
        'Thank you for contacting {{sender_name}}! This is a quick note to confirm we have received your email.',
        'A member of our team will get back to you within one business day. If your matter is urgent, please call or WhatsApp us.',
        'Warm regards,<br>{{sender_name}}',
      ]),
    },
    {
      key: 'auto-after-hours', industry: 'Auto-reply', category: 'auto-reply', mode: 'html',
      name: 'Auto-reply - After office hours',
      subject: 'Thanks for your email - we\'ll reply during office hours',
      html: plain([
        'Hi {{first_name|there}},',
        'Thanks for your email. Our office is currently closed (Monday to Friday, 9:00 AM - 6:00 PM).',
        'We will reply as soon as we are back. In the meantime, you may find answers on our website.',
        'Best regards,<br>{{sender_name}}',
      ]),
    },
    {
      key: 'auto-course-info', industry: 'Auto-reply', category: 'auto-reply', mode: 'html',
      name: 'Auto-reply - Course enquiry information pack',
      subject: 'Course information you requested',
      html: plain([
        'Hi {{first_name|there}},',
        'Thank you for your interest in our courses! Here is a quick overview:',
        '&bull; <strong>Programme:</strong> [course name]<br>&bull; <strong>Next intake:</strong> [date]<br>&bull; <strong>Format:</strong> online / physical<br>&bull; <strong>Fee:</strong> [fee]',
        'You can view the full syllabus and register here: <a href="https://example.com/courses">https://example.com/courses</a>',
        'A consultant will also follow up personally. Feel free to reply with any questions.',
        'Best regards,<br>{{sender_name}}',
      ]),
    },
  ];

  return T;
});
