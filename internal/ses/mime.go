package ses

import (
	"bytes"
	"encoding/base64"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"strings"
	"time"

	"golang.org/x/text/encoding/htmlindex"
)

// Message is a received e-mail, parsed.
type Message struct {
	ID      string // the inbound id (the S3 key = SES's receipt id)
	Date    time.Time
	Text    string // text/plain, or "" (callers fall back to HTML)
	HTML    string
	Raw     []byte
	headers mail.Header
}

var dec = &mime.WordDecoder{CharsetReader: charsetReader}

func charsetReader(charset string, r io.Reader) (io.Reader, error) {
	e, err := htmlindex.Get(charset)
	if err != nil {
		return r, nil // unknown charset: pass the bytes through
	}
	return e.NewDecoder().Reader(r), nil
}

// Header is the decoded first value of a header ("" when absent).
func (m *Message) Header(name string) string {
	v := m.headers.Get(name)
	if d, err := dec.DecodeHeader(v); err == nil {
		return d
	}
	return v
}

// NewMessage builds a Message (tests and fakes).
func NewMessage(id string, date time.Time, headers map[string]string, text string) *Message {
	h := mail.Header{}
	for k, v := range headers {
		h[textproto.CanonicalMIMEHeaderKey(k)] = []string{v}
	}
	return &Message{ID: id, Date: date, Text: text, headers: h}
}

// Parse reads a raw RFC 5322 message: headers, the text and HTML bodies (decoded to UTF-8),
// and delivery-status parts of bounce reports (appended to Text).
func Parse(id string, raw []byte) (*Message, error) {
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	m := &Message{ID: id, Raw: raw, headers: msg.Header}
	if d, err := msg.Header.Date(); err == nil {
		m.Date = d.UTC()
	} else {
		m.Date = time.Now().UTC()
	}
	walk(m, msg.Header.Get("Content-Type"), msg.Header.Get("Content-Transfer-Encoding"), msg.Body, 0)
	return m, nil
}

func decodeBody(enc string, r io.Reader) io.Reader {
	switch strings.ToLower(strings.TrimSpace(enc)) {
	case "base64":
		return base64.NewDecoder(base64.StdEncoding, &stripSpace{r: r})
	case "quoted-printable":
		return quotedprintable.NewReader(r)
	}
	return r
}

// stripSpace drops CR, LF and spaces so line-wrapped base64 decodes.
type stripSpace struct{ r io.Reader }

func (s *stripSpace) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	j := 0
	for i := 0; i < n; i++ {
		if c := p[i]; c != '\r' && c != '\n' && c != ' ' && c != '\t' {
			p[j] = c
			j++
		}
	}
	if j == 0 && err == nil && n > 0 {
		return s.Read(p)
	}
	return j, err
}

func walk(m *Message, ctype, enc string, body io.Reader, depth int) {
	if depth > 10 {
		return
	}
	mt, params, err := mime.ParseMediaType(ctype)
	if err != nil || ctype == "" {
		mt, params = "text/plain", map[string]string{}
	}
	switch {
	case strings.HasPrefix(mt, "multipart/"):
		mr := multipart.NewReader(body, params["boundary"])
		for {
			p, err := mr.NextRawPart()
			if err != nil {
				return
			}
			walk(m, p.Header.Get("Content-Type"), p.Header.Get("Content-Transfer-Encoding"), p, depth+1)
		}
	case mt == "text/plain" || mt == "text/html" || mt == "message/delivery-status":
		r := decodeBody(enc, body)
		if cs := params["charset"]; cs != "" {
			if cr, err := charsetReader(cs, r); err == nil {
				r = cr
			}
		}
		b, _ := io.ReadAll(io.LimitReader(r, 5<<20))
		switch {
		case mt == "text/plain" && m.Text == "":
			m.Text = string(b)
		case mt == "text/html" && m.HTML == "":
			m.HTML = string(b)
		case mt == "message/delivery-status":
			m.Text += "\n" + string(b)
		}
	}
}
