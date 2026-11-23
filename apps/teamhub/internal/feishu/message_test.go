package feishu

import (
	"bytes"
	"slices"
	"testing"
)

func TestMessageRoundTripKeepsBodiesAttachmentsAndThreading(t *testing.T) {
	original := Message{
		To: []string{"alice@example.com"}, Cc: []string{"bob@example.com"}, Bcc: []string{"carol@example.com"},
		Subject: "Re: Q3 plan été \U0001F680", Text: "Plain body\nsecond line", HTML: "<p>Plain body</p>",
		InReplyTo: "<orig@example.com>", References: []string{"<root@example.com>", "<orig@example.com>"},
		Attachments: []Attachment{
			{Name: "report.pdf", ContentType: "application/pdf", Data: bytes.Repeat([]byte{0, 1, 2, 250}, 100)},
			{Name: "logo.png", ContentType: "image/png", ContentID: "logo", Inline: true, Data: []byte("png")},
		},
	}
	raw, err := BuildMessage(original)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseMessage(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(parsed.To, original.To) || !slices.Equal(parsed.Cc, original.Cc) || !slices.Equal(parsed.Bcc, original.Bcc) {
		t.Fatalf("addresses = %v %v %v", parsed.To, parsed.Cc, parsed.Bcc)
	}
	if parsed.Subject != original.Subject || parsed.Text != original.Text || parsed.HTML != original.HTML {
		t.Fatalf("subject=%q text=%q html=%q", parsed.Subject, parsed.Text, parsed.HTML)
	}
	if parsed.InReplyTo != original.InReplyTo || !slices.Equal(parsed.References, original.References) {
		t.Fatalf("threading = %q %v", parsed.InReplyTo, parsed.References)
	}
	if len(parsed.Attachments) != 2 || !bytes.Equal(parsed.Attachments[0].Data, original.Attachments[0].Data) ||
		parsed.Attachments[0].Name != "report.pdf" || !parsed.Attachments[1].Inline || parsed.Attachments[1].ContentID != "logo" {
		t.Fatalf("attachments = %+v", parsed.Attachments)
	}
}

func TestPlainMessageHasOneTextPart(t *testing.T) {
	raw, err := BuildMessage(Message{To: []string{"alice@example.com"}, Subject: "Hi", Text: "Hello"})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("multipart")) {
		t.Fatalf("a plain message became multipart:\n%s", raw)
	}
	parsed, err := ParseMessage(raw)
	if err != nil || parsed.Text != "Hello" || len(parsed.Attachments) != 0 {
		t.Fatalf("parsed = %+v err = %v", parsed, err)
	}
}
