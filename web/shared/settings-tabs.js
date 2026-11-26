/*
 * The tabs of the Settings page (window.SettingsTabs): which tab a URL hash names, and where the old
 * Transactional page's address now leads. Pure logic, tested in test/settings-tabs.test.js.
 * The tab is the second part of the hash: #/settings/integrations. #/settings opens the first tab.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SettingsTabs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TABS = [
    { id: 'general', label: 'General' },
    { id: 'sending', label: 'Sending' },
    { id: 'integrations', label: 'Integrations' },
    { id: 'transactional', label: 'Transactional e-mails' },
  ];
  const FIRST = TABS[0].id;

  /** The tab id a hash such as "#/settings/sending?x=1" names; the first tab when none or unknown. */
  function tabFromHash(hash) {
    const m = /^#\/settings(?:\/([^/?#]*))?/.exec(String(hash || ''));
    const id = m && m[1] ? m[1].toLowerCase() : '';
    return TABS.some((t) => t.id === id) ? id : FIRST;
  }

  /** The hash of a tab, with an optional query string (without the "?"). */
  function hashFor(tab, qs) {
    const id = TABS.some((t) => t.id === tab) ? tab : FIRST;
    return `#/settings/${id}${qs ? `?${qs}` : ''}`;
  }

  /** The old Transactional page's hash (#/transactional?q=…) becomes its tab; anything else is null. */
  function legacyRedirect(hash) {
    const m = /^#\/transactional(?:\?(.*))?$/.exec(String(hash || ''));
    return m ? hashFor('transactional', m[1]) : null;
  }

  return { TABS, FIRST, tabFromHash, hashFor, legacyRedirect };
});
