package feishu

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"strings"
	"time"
)

// Attachment is one file part of a message.
type Attachment struct {
	Name        string
	ContentType string
	ContentID   string
	Inline      bool
	Data        []byte
}

// Message is an email as TeamHub builds or edits it. Feishu's draft API takes
// whole RFC 5322 messages, so drafts are built here and an update rewrites the
// draft from its parsed parts.
type Message struct {
	To, Cc, Bcc []string
	Subject     string
	Text        string
	HTML        string
	InReplyTo   string
	References  []string
	Attachments []Attachment
}

// ErrMalformedMessage reports a draft whose MIME structure TeamHub cannot
// rebuild without losing parts.
var ErrMalformedMessage = errors.New("the Feishu draft is not a message TeamHub can rebuild")

// BuildMessage encodes msg as an RFC 5322 message: text and HTML bodies as
// alternatives, and attachments, inline ones included, as parts beside them.
func BuildMessage(msg Message) ([]byte, error) {
	var out bytes.Buffer
	header := func(name, value string) {
		if value != "" {
			fmt.Fprintf(&out, "%s: %s\r\n", name, value)
		}
	}
	header("Date", time.Now().UTC().Format(time.RFC1123Z))
	header("Message-ID", newMessageID())
	header("To", addressList(msg.To))
	header("Cc", addressList(msg.Cc))
	header("Bcc", addressList(msg.Bcc))
	header("Subject", mime.QEncoding.Encode("utf-8", msg.Subject))
	header("In-Reply-To", msg.InReplyTo)
	header("References", strings.Join(msg.References, " "))
	header("MIME-Version", "1.0")
	body, bodyHeader, err := bodyPart(msg)
	if err != nil {
		return nil, err
	}
	if len(msg.Attachments) == 0 {
		for _, name := range []string{"Content-Type", "Content-Transfer-Encoding"} {
			header(name, bodyHeader.Get(name))
		}
		out.WriteString("\r\n")
		out.Write(body)
		return out.Bytes(), nil
	}
	writer := multipart.NewWriter(&out)
	header("Content-Type", "multipart/mixed; boundary="+writer.Boundary())
	out.WriteString("\r\n")
	part, err := writer.CreatePart(bodyHeader)
	if err != nil {
		return nil, err
	}
	if _, err = part.Write(body); err != nil {
		return nil, err
	}
	for _, attachment := range msg.Attachments {
		if err = writeAttachment(writer, attachment); err != nil {
			return nil, err
		}
	}
	if err = writer.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// bodyPart returns the encoded body and its part header: one text part, or
// text and HTML as multipart/alternative.
func bodyPart(msg Message) ([]byte, textproto.MIMEHeader, error) {
	if msg.HTML == "" {
		return quotedPrintable(msg.Text), textproto.MIMEHeader{
			"Content-Type":              {`text/plain; charset="utf-8"`},
			"Content-Transfer-Encoding": {"quoted-printable"},
		}, nil
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, alternative := range []struct{ kind, text string }{{"text/plain", msg.Text}, {"text/html", msg.HTML}} {
		if alternative.text == "" {
			continue
		}
		part, err := writer.CreatePart(textproto.MIMEHeader{
			"Content-Type":              {alternative.kind + `; charset="utf-8"`},
			"Content-Transfer-Encoding": {"quoted-printable"},
		})
		if err != nil {
			return nil, nil, err
		}
		if _, err = part.Write(quotedPrintable(alternative.text)); err != nil {
			return nil, nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, nil, err
	}
	return body.Bytes(), textproto.MIMEHeader{"Content-Type": {"multipart/alternative; boundary=" + writer.Boundary()}}, nil
}

func writeAttachment(writer *multipart.Writer, attachment Attachment) error {
	contentType := attachment.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	disposition := "attachment"
	if attachment.Inline {
		disposition = "inline"
	}
	header := textproto.MIMEHeader{
		"Content-Type":              {mime.FormatMediaType(contentType, map[string]string{"name": attachment.Name})},
		"Content-Disposition":       {mime.FormatMediaType(disposition, map[string]string{"filename": attachment.Name})},
		"Content-Transfer-Encoding": {"base64"},
	}
	if attachment.ContentID != "" {
		header.Set("Content-ID", "<"+strings.Trim(attachment.ContentID, "<>")+">")
	}
	part, err := writer.CreatePart(header)
	if err != nil {
		return err
	}
	encoded := base64.StdEncoding.EncodeToString(attachment.Data)
	for len(encoded) > 76 {
		if _, err = io.WriteString(part, encoded[:76]+"\r\n"); err != nil {
			return err
		}
		encoded = encoded[76:]
	}
	_, err = io.WriteString(part, encoded+"\r\n")
	return err
}

// ParseMessage reads the parts TeamHub builds back from a message: addresses,
// subject, threading headers, text and HTML bodies, and file parts.
func ParseMessage(raw []byte) (Message, error) {
	parsed, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return Message{}, errors.Join(ErrMalformedMessage, err)
	}
	decoder := new(mime.WordDecoder)
	subject, err := decoder.DecodeHeader(parsed.Header.Get("Subject"))
	if err != nil {
		subject = parsed.Header.Get("Subject")
	}
	msg := Message{
		To: headerAddresses(parsed.Header, "To"), Cc: headerAddresses(parsed.Header, "Cc"), Bcc: headerAddresses(parsed.Header, "Bcc"),
		Subject: subject, InReplyTo: strings.TrimSpace(parsed.Header.Get("In-Reply-To")),
		References: strings.Fields(parsed.Header.Get("References")),
	}
	if err = readPart(&msg, textproto.MIMEHeader(parsed.Header), parsed.Body, 0); err != nil {
		return Message{}, err
	}
	return msg, nil
}

func readPart(msg *Message, header textproto.MIMEHeader, body io.Reader, depth int) error {
	if depth > 8 {
		return ErrMalformedMessage
	}
	mediaType, params, err := mime.ParseMediaType(header.Get("Content-Type"))
	if err != nil {
		mediaType, params = "text/plain", map[string]string{}
	}
	if strings.HasPrefix(mediaType, "multipart/") {
		reader := multipart.NewReader(body, params["boundary"])
		for {
			part, err := reader.NextRawPart()
			if errors.Is(err, io.EOF) {
				return nil
			}
			if err != nil {
				return errors.Join(ErrMalformedMessage, err)
			}
			if err = readPart(msg, part.Header, part, depth+1); err != nil {
				return err
			}
		}
	}
	content, err := decodeTransfer(header.Get("Content-Transfer-Encoding"), body)
	if err != nil {
		return err
	}
	disposition, dispositionParams, _ := mime.ParseMediaType(header.Get("Content-Disposition"))
	name := dispositionParams["filename"]
	if name == "" {
		name = params["name"]
	}
	contentID := strings.Trim(header.Get("Content-ID"), "<> ")
	if disposition == "" && name == "" && contentID == "" && (mediaType == "text/plain" || mediaType == "text/html") {
		// Mail carries CRLF line breaks; TeamHub's bodies use LF.
		text := strings.ReplaceAll(string(content), "\r\n", "\n")
		if mediaType == "text/html" && msg.HTML == "" {
			msg.HTML = text
		} else if mediaType == "text/plain" && msg.Text == "" {
			msg.Text = text
		}
		return nil
	}
	msg.Attachments = append(msg.Attachments, Attachment{
		Name: name, ContentType: mediaType, ContentID: contentID, Inline: disposition == "inline", Data: content,
	})
	return nil
}

func decodeTransfer(encoding string, body io.Reader) ([]byte, error) {
	limited := io.LimitReader(body, 64<<20)
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "base64":
		raw, err := io.ReadAll(limited)
		if err != nil {
			return nil, err
		}
		decoded, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(string(raw)), ""))
		if err != nil {
			return nil, errors.Join(ErrMalformedMessage, err)
		}
		return decoded, nil
	case "quoted-printable":
		return io.ReadAll(quotedprintable.NewReader(limited))
	default:
		return io.ReadAll(limited)
	}
}

func headerAddresses(header mail.Header, name string) []string {
	list, err := header.AddressList(name)
	if err != nil {
		return nil
	}
	addresses := make([]string, 0, len(list))
	for _, address := range list {
		addresses = append(addresses, address.Address)
	}
	return addresses
}

func addressList(addresses []string) string {
	formatted := make([]string, 0, len(addresses))
	for _, address := range addresses {
		formatted = append(formatted, (&mail.Address{Address: address}).String())
	}
	return strings.Join(formatted, ", ")
}

func quotedPrintable(text string) []byte {
	var out bytes.Buffer
	writer := quotedprintable.NewWriter(&out)
	_, _ = writer.Write([]byte(text))
	_ = writer.Close()
	return out.Bytes()
}

func newMessageID() string {
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	return "<" + hex.EncodeToString(raw) + "@linger.mail>"
}
