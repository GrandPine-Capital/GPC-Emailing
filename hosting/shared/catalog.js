// GENERATED from shared/ by scripts/sync-shared.js - edit the file in shared/ instead.
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

  const INDUSTRIES = ["Accounting","Advertising & Marketing","Agriculture","Architecture","Automotive","Banking & Finance","Construction","Consulting","E-commerce","Education & Training","Energy & Utilities","Engineering","Food & Beverage","Healthcare & Medical","Hospitality & Hotels","Human Resources & Recruitment","Information Technology","Insurance","Investment & Asset Management","Legal Services","Logistics & Shipping","Manufacturing","Media & Publishing","Non-profit","Oil & Gas","Pharmaceuticals","Real Estate","Retail","Software & SaaS","Telecommunications","Travel & Tourism","Wholesale & Distribution"];

  const TRIGGERS = {
    email_sent: 'After an email is sent (optionally from a specific campaign / template)',
    email_opened: 'When a contact opens an email',
    link_clicked: 'When a contact clicks a link (optionally matching a URL)',
    reply_received: 'When a reply is received (optionally containing keywords)',
    contact_added: 'When a contact is added to a list',
    manual: 'Only when started manually for selected contacts',
  };

  const STEP_TYPES = {
    wait: 'Wait for an amount of minutes / hours / days',
    send_email: 'Send an email using a template',
    stop_if: 'Stop the automation if a condition is met (replied, opened, clicked, ...)',
    add_tag: 'Add a tag to the contact',
    remove_tag: 'Remove a tag from the contact',
    add_to_list: 'Add the contact to a list',
    remove_from_list: 'Remove the contact from a list',
    update_field: 'Set a contact field (country, industry, company, ...)',
    notify: 'Send an internal notification email to your team',
    webhook: 'POST the event to an external URL (CRM, Slack, Zapier, ...)',
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

  return { COUNTRIES: COUNTRIES, INDUSTRIES: INDUSTRIES, TRIGGERS: TRIGGERS, STEP_TYPES: STEP_TYPES, MERGE_TAGS: MERGE_TAGS, byCode: byCode, countryName: countryName };
});
