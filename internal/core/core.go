// Package core holds the e-mail helpers the dashboard also has in web/shared/email-core.js:
// merge tags, HTML to text, address and phone normalisation. Keep the two in step;
// core_test.go pins the shared behaviour.
package core

import (
	"html"
	"regexp"
	"strings"
)

// ContactFields are the free-text contact fields the API and automations may set.
var ContactFields = []string{"first_name", "last_name", "company", "website", "phone", "country", "industry"}

// IsContactField reports whether f is one of ContactFields.
func IsContactField(f string) bool {
	for _, c := range ContactFields {
		if c == f {
			return true
		}
	}
	return false
}

// SampleContact fills previews and test sends when the address is not a contact.
var SampleContact = map[string]string{
	"email": "alex@example.com", "first_name": "Alex", "last_name": "Tan", "company": "Sample Sdn Bhd",
	"country": "Malaysia", "industry": "Information Technology", "website": "https://example.com",
}

// EscapeHTML escapes &, <, > and " (as email-core.js does; ' is left alone).
func EscapeHTML(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

// FullName joins first and last name.
func FullName(first, last string) string {
	return strings.TrimSpace(strings.Join(nonEmpty(first, last), " "))
}

func nonEmpty(parts ...string) []string {
	out := []string{}
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// ContactVars are the merge tags a contact provides.
func ContactVars(c map[string]string) map[string]string {
	return map[string]string{
		"email": c["email"], "first_name": c["first_name"], "last_name": c["last_name"],
		"full_name": FullName(c["first_name"], c["last_name"]), "company": c["company"], "website": c["website"],
		"phone": c["phone"], "country": c["country"], "industry": c["industry"],
	}
}

var mergeRe = regexp.MustCompile(`\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}`)

// Merge replaces {{tag}} and {{tag|fallback}}. With escape, values are HTML-escaped, except
// *_url tags, which the service generates itself.
func Merge(text string, vars map[string]string, escape bool) string {
	return mergeRe.ReplaceAllStringFunc(text, func(m string) string {
		sub := mergeRe.FindStringSubmatch(m)
		key, fallback := sub[1], sub[2]
		out := vars[key]
		if out == "" {
			out = fallback
		}
		if escape && !strings.HasSuffix(key, "_url") {
			return EscapeHTML(out)
		}
		return out
	})
}

var (
	styleRe     = regexp.MustCompile(`(?is)<style.*?</style>`)
	preheaderRe = regexp.MustCompile(`(?is)<div style="display:none[^"]*">.*?</div>`)
	anchorRe    = regexp.MustCompile(`(?is)<a [^>]*href="([^"]+)"[^>]*>(.*?)</a>`)
	breakRe     = regexp.MustCompile(`(?i)<(br|/p|/div|/h[1-6]|/tr|/li)[^>]*>`)
	tagRe       = regexp.MustCompile(`<[^>]+>`)
	spacesRe    = regexp.MustCompile(`[ \t]+`)
	blankRe     = regexp.MustCompile(`\n\s*\n\s*\n+`)
)

// HTMLToText is the plain-text alternative of an HTML e-mail.
func HTMLToText(h string) string {
	s := styleRe.ReplaceAllString(h, "")
	s = preheaderRe.ReplaceAllString(s, "")
	s = anchorRe.ReplaceAllString(s, "$2 ($1)")
	s = breakRe.ReplaceAllString(s, "\n")
	s = tagRe.ReplaceAllString(s, "")
	s = strings.NewReplacer("&nbsp;", " ", "&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'").Replace(s)
	s = spacesRe.ReplaceAllString(s, " ")
	s = blankRe.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

var emailRe = regexp.MustCompile(`(?i)^[^\s@<>()\[\]\\,;:"/]+@[^\s@<>()\[\]\\,;:"/]+\.[a-z]{2,}$`)

func IsEmail(s string) bool { return emailRe.MatchString(strings.TrimSpace(s)) }

// EmailKey is a contact's id for an e-mail address: trimmed and lower-case.
func EmailKey(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

var tagSplitRe = regexp.MustCompile(`[,;|]`)

// NormaliseTags trims, drops empties and de-duplicates, keeping order.
func NormaliseTags(tags []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, t := range tags {
		v := strings.TrimSpace(t)
		if v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// SplitTags normalises a comma, semicolon or bar separated list.
func SplitTags(s string) []string { return NormaliseTags(tagSplitRe.Split(s, -1)) }

var (
	phoneAtRe    = regexp.MustCompile(`@.*$`)
	phoneCharsRe = regexp.MustCompile(`[^0-9+]`)
	nonDigitRe   = regexp.MustCompile(`\D`)
)

// PhoneKey normalises a phone number to international digits for WhatsApp, e.g. "012-345 6789"
// with country code "60" gives "60123456789". "" when it is not a plausible number.
func PhoneKey(phone, defaultCountryCode string) string {
	d := phoneCharsRe.ReplaceAllString(phoneAtRe.ReplaceAllString(phone, ""), "")
	if d == "" {
		return ""
	}
	switch {
	case strings.HasPrefix(d, "+"):
		d = d[1:]
	case strings.HasPrefix(d, "00"):
		d = d[2:]
	case strings.HasPrefix(d, "0") && defaultCountryCode != "":
		d = nonDigitRe.ReplaceAllString(defaultCountryCode, "") + d[1:]
	}
	d = nonDigitRe.ReplaceAllString(d, "")
	if len(d) >= 8 && len(d) <= 15 {
		return d
	}
	return ""
}

var angleRe = regexp.MustCompile(`<([^>]+)>`)

// AddressOf is the lower-case address in a From header ("Name <a@b.c>" or "a@b.c").
func AddressOf(from string) string {
	if m := angleRe.FindStringSubmatch(from); m != nil {
		return strings.ToLower(strings.TrimSpace(m[1]))
	}
	return strings.ToLower(strings.TrimSpace(from))
}

var (
	wroteRe    = regexp.MustCompile(`(?i)^On .+wrote:\s*$`)
	origMsgRe  = regexp.MustCompile(`(?i)^-{2,}\s*Original Message`)
	fromLineRe = regexp.MustCompile(`(?i)^From:\s`)
	quotedRe   = regexp.MustCompile(`^\s*>`)
)

// StripQuoted drops quoted history, so keyword triggers only see what the sender wrote.
func StripQuoted(text string) string {
	out := []string{}
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if wroteRe.MatchString(line) || origMsgRe.MatchString(line) || fromLineRe.MatchString(line) {
			break
		}
		if quotedRe.MatchString(line) {
			continue
		}
		out = append(out, line)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// Words splits a comma-separated keyword list into trimmed lower-case words.
func Words(list string) []string {
	out := []string{}
	for _, w := range strings.Split(list, ",") {
		if w = strings.ToLower(strings.TrimSpace(w)); w != "" {
			out = append(out, w)
		}
	}
	return out
}

// Truncate cuts s to at most n bytes without splitting a UTF-8 character.
func Truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && n < len(s) && (s[n]&0xC0) == 0x80 {
		n--
	}
	return s[:n]
}

// UnescapeHTML decodes entities (for text pulled out of HTML).
func UnescapeHTML(s string) string { return html.UnescapeString(s) }
