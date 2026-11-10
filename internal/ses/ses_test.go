package ses

import (
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	raw := "From: =?UTF-8?B?QWxpY2Ugw4l0w6k=?= <alice@acme.com>\r\n" +
		"To: sales@reply.grandpine.com\r\n" +
		"Subject: Re: Hello\r\n" +
		"Date: Mon, 10 Nov 2026 10:00:00 +0800\r\n" +
		"In-Reply-To: <abc@ap-southeast-5.amazonses.com>\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: multipart/alternative; boundary=\"b1\"\r\n\r\n" +
		"--b1\r\nContent-Type: text/plain; charset=\"iso-8859-1\"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=E9 tomorrow?\r\n" +
		"--b1\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\nPHA+Q2Fmw6k8L3A+\r\n" +
		"--b1--\r\n"
	m, err := Parse("k1", []byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if m.Header("From") != "Alice Été <alice@acme.com>" || m.Header("in-reply-to") != "<abc@ap-southeast-5.amazonses.com>" {
		t.Errorf("headers: %q %q", m.Header("From"), m.Header("In-Reply-To"))
	}
	if strings.TrimSpace(m.Text) != "Café tomorrow?" || m.HTML != "<p>Café</p>" || m.Date.Hour() != 2 {
		t.Errorf("body %q html %q date %v", m.Text, m.HTML, m.Date)
	}
}

func TestParseEvent(t *testing.T) {
	sns := `{"Type":"Notification","Message":"{\"eventType\":\"Bounce\",\"mail\":{\"messageId\":\"m1\"},\"bounce\":{\"bounceType\":\"Permanent\",\"bouncedRecipients\":[{\"emailAddress\":\"Bob@Beta.io\"}]}}"}`
	ev, err := ParseEvent(sns)
	if err != nil || ev.Type != "Bounce" || !ev.Permanent || ev.MessageID != "m1" || ev.Recipients[0] != "bob@beta.io" {
		t.Errorf("bounce %+v %v", ev, err)
	}
	ev, _ = ParseEvent(`{"notificationType":"Complaint","mail":{"messageId":"m2"},"complaint":{"complainedRecipients":[{"emailAddress":"c@x.io"}]}}`)
	if ev.Type != "Complaint" || ev.Recipients[0] != "c@x.io" {
		t.Errorf("complaint %+v", ev)
	}
}

func TestRFCMessageIDAndQueueRegion(t *testing.T) {
	if RFCMessageID("ap-southeast-5", "x") != "<x@ap-southeast-5.amazonses.com>" || RFCMessageID("us-east-1", "x") != "<x@email.amazonses.com>" {
		t.Error("RFCMessageID")
	}
	if regionOfQueue("https://sqs.ap-southeast-1.amazonaws.com/123/q") != "ap-southeast-1" {
		t.Error("regionOfQueue")
	}
}
