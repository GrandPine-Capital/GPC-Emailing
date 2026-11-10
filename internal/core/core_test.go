package core

import (
	"reflect"
	"testing"
)

// The same cases as test/shared.test.js, so the Go and browser helpers agree.

func TestMerge(t *testing.T) {
	vars := map[string]string{"first_name": "", "company": "A&B <Co>", "unsubscribe_url": "https://x/u?a=1&b=2"}
	cases := []struct {
		in     string
		escape bool
		want   string
	}{
		{"Hi {{first_name|there}} from {{ company }}", false, "Hi there from A&B <Co>"},
		{"{{company}}", true, "A&amp;B &lt;Co&gt;"},
		{"{{unsubscribe_url}}", true, "https://x/u?a=1&b=2"},
		{"{{unknown}}!", false, "!"},
		{"{{ first_name | friend }}", false, "friend"},
	}
	for _, c := range cases {
		if got := Merge(c.in, vars, c.escape); got != c.want {
			t.Errorf("Merge(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestHelpers(t *testing.T) {
	if !IsEmail("a.b+c@d.co") || IsEmail("nope") || IsEmail("a/b@c.com") {
		t.Error("IsEmail")
	}
	if EmailKey(" Alice@Acme.COM ") != "alice@acme.com" {
		t.Error("EmailKey")
	}
	if got := SplitTags("a, b;a | c"); !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Errorf("SplitTags = %v", got)
	}
	if AddressOf("Alice <ALICE@x.com>") != "alice@x.com" || AddressOf("bob@y.com") != "bob@y.com" {
		t.Error("AddressOf")
	}
	if got := StripQuoted("Yes please\n\nOn Mon, Bob wrote:\n> hi"); got != "Yes please" {
		t.Errorf("StripQuoted = %q", got)
	}
	if got := HTMLToText(`<p>Hi</p><a href="https://x.com">Go</a>`); got != "Hi\nGo (https://x.com)" {
		t.Errorf("HTMLToText = %q", got)
	}
	for in, want := range map[string]string{"012-345 6789": "60123456789", "+65 9123 4567": "6591234567", "0060123456789": "60123456789", "123": "", "60123456789@s.whatsapp.net": "60123456789"} {
		if got := PhoneKey(in, "60"); got != want {
			t.Errorf("PhoneKey(%q) = %q, want %q", in, got, want)
		}
	}
	if Truncate("héllo", 2) != "h" {
		t.Error("Truncate must not split a character")
	}
}
