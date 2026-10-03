/*
 * Static catalogue shared by the web app (window.EmailCatalog) and the
 * Apps Script worker (global EmailCatalog): countries, industries,
 * automation triggers / steps and merge tags.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmailCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // [ISO code, name, DuckDuckGo region]
  const COUNTRIES = [["MY","Malaysia","my-en"],["SG","Singapore","sg-en"],["ID","Indonesia","id-en"],["TH","Thailand","th-en"],["VN","Vietnam","vn-en"],["PH","Philippines","ph-en"],["CN","China","cn-zh"],["HK","Hong Kong","hk-tzh"],["TW","Taiwan","tw-tzh"],["JP","Japan","jp-jp"],["KR","South Korea","kr-kr"],["IN","India","in-en"],["PK","Pakistan","pk-en"],["BD","Bangladesh","wt-wt"],["LK","Sri Lanka","wt-wt"],["AU","Australia","au-en"],["NZ","New Zealand","nz-en"],["AE","United Arab Emirates","xa-en"],["SA","Saudi Arabia","xa-en"],["QA","Qatar","xa-en"],["TR","Turkey","tr-tr"],["IL","Israel","il-en"],["EG","Egypt","xa-en"],["ZA","South Africa","za-en"],["NG","Nigeria","wt-wt"],["KE","Kenya","wt-wt"],["GB","United Kingdom","uk-en"],["IE","Ireland","ie-en"],["DE","Germany","de-de"],["FR","France","fr-fr"],["ES","Spain","es-es"],["IT","Italy","it-it"],["NL","Netherlands","nl-nl"],["BE","Belgium","be-fr"],["CH","Switzerland","ch-de"],["AT","Austria","at-de"],["SE","Sweden","se-sv"],["NO","Norway","no-no"],["DK","Denmark","dk-da"],["FI","Finland","fi-fi"],["PL","Poland","pl-pl"],["PT","Portugal","pt-pt"],["GR","Greece","gr-gr"],["CZ","Czech Republic","cz-cs"],["RO","Romania","ro-ro"],["HU","Hungary","hu-hu"],["US","United States","us-en"],["CA","Canada","ca-en"],["MX","Mexico","mx-es"],["BR","Brazil","br-pt"],["AR","Argentina","ar-es"],["CL","Chile","cl-es"],["CO","Colombia","co-es"],["PE","Peru","pe-es"]].map(function (c) { return { code: c[0], name: c[1], region: c[2] }; });

  /*
   * Focus industries: each has related sub-sectors and the search phrases the
   * Lead Finder uses (several searches per industry find far more companies
   * than one generic query).
   */
  const FOCUS_INDUSTRIES = [
    { group: 'Education', name: 'Education', keywords: ['education centre', 'private school', 'learning centre', 'training academy'] },
    { group: 'Education', name: 'Tuition & Learning Centres', keywords: ['tuition centre', 'enrichment centre', 'learning centre for kids'] },
    { group: 'Education', name: 'Online Courses & E-learning', keywords: ['online course provider', 'e-learning company', 'online academy'] },
    { group: 'Education', name: 'Professional Training Providers', keywords: ['professional training provider', 'HRDF training provider', 'corporate training company'] },
    { group: 'Education', name: 'Early Childhood Education', keywords: ['kindergarten', 'preschool', 'childcare centre'] },
    { group: 'Education', name: 'Language Schools', keywords: ['language school', 'English language centre', 'Mandarin learning centre'] },
    { group: 'Investment', name: 'Investment Education', keywords: ['investment education', 'stock market course', 'trading academy', 'financial literacy course'] },
    { group: 'Investment', name: 'Investment Tools', keywords: ['investment tools', 'stock screener', 'trading software', 'investment platform'] },
    { group: 'Investment', name: 'Trading & Stock Market Courses', keywords: ['stock trading course', 'forex trading course', 'technical analysis course'] },
    { group: 'Investment', name: 'Financial Planning & Wealth Management', keywords: ['financial planner', 'wealth management firm', 'licensed financial adviser'] },
    { group: 'Investment', name: 'Fintech', keywords: ['fintech company', 'robo advisor', 'digital investment platform'] },
    { group: 'Dental', name: 'Dental Lab', keywords: ['dental laboratory', 'dental lab', 'dental technician', 'crown and bridge lab'] },
    { group: 'Dental', name: 'Dental Clinics', keywords: ['dental clinic', 'dentist', 'dental surgery'] },
    { group: 'Dental', name: 'Orthodontics & Aligners', keywords: ['orthodontist', 'clear aligner provider', 'braces clinic'] },
    { group: 'Dental', name: 'Dental Supplies & Equipment', keywords: ['dental supplies', 'dental equipment supplier', 'dental materials distributor'] },
    { group: 'Soul, mind & numerology', name: 'Numerology Education', keywords: ['numerology course', 'numerology academy', 'numerology consultant'] },
    { group: 'Soul, mind & numerology', name: 'Metaphysics & Feng Shui', keywords: ['feng shui consultant', 'bazi course', 'metaphysics academy'] },
    { group: 'Soul, mind & numerology', name: 'Soul & Mind Education', keywords: ['mindfulness course', 'meditation centre', 'spiritual wellness academy', 'soul healing workshop'] },
    { group: 'Soul, mind & numerology', name: 'Holistic Wellness & Healing', keywords: ['holistic wellness centre', 'energy healing course', 'reiki training'] },
    { group: 'Personal & talent development', name: 'Personal Development Education', keywords: ['personal development course', 'self improvement workshop', 'life coaching academy'] },
    { group: 'Personal & talent development', name: 'Life & Executive Coaching', keywords: ['life coach', 'executive coaching', 'NLP training'] },
    { group: 'Personal & talent development', name: 'Human Development & Talent Management', keywords: ['talent management', 'human capital development', 'talent development consultancy', 'HR consulting'] },
    { group: 'Personal & talent development', name: 'Leadership & Corporate Training', keywords: ['leadership training', 'corporate training provider', 'soft skills training'] },
    { group: 'Personal & talent development', name: 'Psychology & Counselling', keywords: ['counselling centre', 'psychologist practice', 'psychometric assessment'] },
  ];

  const INDUSTRIES = FOCUS_INDUSTRIES.map(function (i) { return i.name; }).concat(["Accounting","Advertising & Marketing","Agriculture","Architecture","Automotive","Banking & Finance","Construction","Consulting","E-commerce","Education & Training","Energy & Utilities","Engineering","Food & Beverage","Healthcare & Medical","Hospitality & Hotels","Human Resources & Recruitment","Information Technology","Insurance","Investment & Asset Management","Legal Services","Logistics & Shipping","Manufacturing","Media & Publishing","Non-profit","Oil & Gas","Pharmaceuticals","Real Estate","Retail","Software & SaaS","Telecommunications","Travel & Tourism","Wholesale & Distribution"].filter(function (n, i, all) { return all.indexOf(n) === i; }));

  /** Search phrases for an industry (focus industries have several). */
  function industryKeywords(name) {
    for (let i = 0; i < FOCUS_INDUSTRIES.length; i++) if (FOCUS_INDUSTRIES[i].name === name) return FOCUS_INDUSTRIES[i].keywords.slice();
    return name ? [name] : [];
  }

  // Automation triggers. `group` and `icon` drive the dashboard's builder.
  const TRIGGERS = {
    email_sent: { label: 'Email sent', group: 'Email', icon: 'send', description: 'Right after an email (campaign or automation) is sent to the contact' },
    email_opened: { label: 'Email opened', group: 'Email', icon: 'mail-open', description: 'When the contact opens one of your emails' },
    link_clicked: { label: 'Link clicked', group: 'Email', icon: 'pointer', description: 'When the contact clicks a link (optionally a specific URL)' },
    email_received: { label: 'Any email received', group: 'Email', icon: 'mail-open', description: 'When any email arrives in your connected inbox from a known contact (optionally containing keywords)' },
    reply_received: { label: 'Email reply received', group: 'Email', icon: 'reply', description: 'When the contact replies by email (optionally containing keywords)' },
    bounced: { label: 'Email bounced', group: 'Email', icon: 'alert', description: 'When an email to the contact bounces' },
    unsubscribed: { label: 'Contact unsubscribed', group: 'Email', icon: 'user-x', description: 'When the contact unsubscribes from your emails' },
    contact_added: { label: 'Added to a list', group: 'Contacts', icon: 'user-plus', description: 'When a contact is added to a list (import, form, lead finder…)' },
    tag_added: { label: 'Tag added', group: 'Contacts', icon: 'tag', description: 'When a tag is added to a contact' },
    whatsapp_received: { label: 'WhatsApp message received', group: 'WhatsApp', icon: 'whatsapp', description: 'When a contact messages you on WhatsApp (via ChatDaddy webhook)' },
    webhook_received: { label: 'Webhook received', group: 'Integrations', icon: 'webhook', description: 'When another app (form, CRM, Zapier, ChatDaddy…) posts to your webhook URL' },
    manual: { label: 'Manual enrolment', group: 'Contacts', icon: 'play', description: 'Only when you enrol contacts or a list yourself' },
  };

  const STEP_TYPES = {
    send_email: { label: 'Send email', group: 'Email', icon: 'mail', description: 'Send an email template (optionally as a reply in the same thread)' },
    send_whatsapp: { label: 'Send WhatsApp message', group: 'WhatsApp', icon: 'whatsapp', description: 'Send a WhatsApp message via ChatDaddy or the WhatsApp Cloud API' },
    chatdaddy_contact: { label: 'Sync contact to ChatDaddy', group: 'WhatsApp', icon: 'refresh', description: 'Create/update the contact in ChatDaddy with tags' },
    wait: { label: 'Wait', group: 'Timing & logic', icon: 'clock', description: 'Pause for minutes, hours or days' },
    stop_if: { label: 'Stop if…', group: 'Timing & logic', icon: 'stop', description: 'End the automation when a condition is met (replied, opened, has tag…)' },
    add_tag: { label: 'Add tag', group: 'Contact', icon: 'tag', description: 'Add a tag to the contact' },
    remove_tag: { label: 'Remove tag', group: 'Contact', icon: 'tag', description: 'Remove a tag from the contact' },
    add_to_list: { label: 'Add to list', group: 'Contact', icon: 'list-plus', description: 'Add the contact to a list' },
    remove_from_list: { label: 'Remove from list', group: 'Contact', icon: 'list-minus', description: 'Remove the contact from a list' },
    update_field: { label: 'Update contact field', group: 'Contact', icon: 'edit', description: 'Set country, industry, company, status…' },
    notify: { label: 'Notify my team', group: 'Team & integrations', icon: 'bell', description: 'Alert your team by email and/or WhatsApp' },
    webhook: { label: 'Call a webhook', group: 'Team & integrations', icon: 'webhook', description: 'POST the event to another app (CRM, Slack, Zapier, ChatDaddy flows…)' },
  };

  const STOP_CONDITIONS = {
    replied: 'has replied (email or WhatsApp)',
    opened: 'has opened an email',
    clicked: 'has clicked a link',
    not_opened: 'has NOT opened any email',
    not_clicked: 'has NOT clicked any link',
    unsubscribed: 'has unsubscribed or bounced',
    has_tag: 'has the tag…',
    not_has_tag: 'does NOT have the tag…',
  };

  const MERGE_TAGS = ['first_name', 'last_name', 'full_name', 'email', 'company', 'website', 'phone', 'country', 'industry', 'sender_name', 'company_address', 'unsubscribe_url'];

  function byCode(code) {
    const c = String(code || '').toUpperCase();
    for (let i = 0; i < COUNTRIES.length; i++) if (COUNTRIES[i].code === c) return COUNTRIES[i];
    return null;
  }
  function countryName(v) {
    const c = byCode(v);
    return c ? c.name : v;
  }

  return { COUNTRIES: COUNTRIES, INDUSTRIES: INDUSTRIES, FOCUS_INDUSTRIES: FOCUS_INDUSTRIES, industryKeywords: industryKeywords, TRIGGERS: TRIGGERS, STEP_TYPES: STEP_TYPES, STOP_CONDITIONS: STOP_CONDITIONS, MERGE_TAGS: MERGE_TAGS, byCode: byCode, countryName: countryName };
});
