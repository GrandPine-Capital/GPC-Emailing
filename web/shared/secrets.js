/*
 * A fresh random signing secret for the Settings page (window.EmailSecrets). Pure logic, tested
 * in test/secrets.test.js. URL-safe alphabet of 64 characters, so one random byte maps evenly
 * onto it (byte & 63) and the value can be pasted anywhere without escaping.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmailSecrets = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  /** `fill` is crypto.getRandomValues (or a stand-in); returns `length` URL-safe characters. */
  function generateSecret(fill, length = 48) {
    const bytes = fill(new Uint8Array(length));
    let out = '';
    for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] & 63];
    return out;
  }

  return { generateSecret, ALPHABET };
});
