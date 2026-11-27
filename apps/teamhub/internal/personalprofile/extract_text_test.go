package personalprofile

import (
	"archive/zip"
	"bytes"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestProfileDOCXPreservesTextAcrossFormattingRuns(t *testing.T) {
	for _, test := range []struct {
		name, content, want string
	}{
		{
			name: "formatted email",
			content: `<w:p><w:r><w:t>al</w:t></w:r>` +
				`<w:r><w:rPr><w:b/></w:rPr><w:t>ice</w:t></w:r>` +
				`<w:hyperlink><w:r><w:t>@example.org</w:t></w:r></w:hyperlink></w:p>`,
			want: "alice@example.org",
		},
		{
			name: "whitespace-only run",
			content: `<w:p><w:r><w:t>Given</w:t></w:r>` +
				`<w:r><w:t xml:space="preserve">  </w:t></w:r>` +
				`<w:r><w:t>Family</w:t></w:r></w:p>`,
			want: "Given  Family",
		},
		{
			name: "paragraphs tabs and breaks",
			content: `<w:p><w:r><w:t>Role</w:t><w:tab/><w:t>Engineer</w:t>` +
				`<w:br/><w:t>Remote</w:t><w:cr/><w:t>Since 2024</w:t></w:r></w:p>` +
				`<w:p><w:r><w:t>Next employer</w:t></w:r></w:p>`,
			want: "Role\tEngineer\nRemote\nSince 2024\nNext employer",
		},
		{
			name: "text-box tab-stop properties are not content",
			content: `<w:p><w:r><w:t>A</w:t></w:r><w:r><w:drawing><w:txbxContent>` +
				`<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>` +
				`<w:r><w:t>Box</w:t><w:tab/><w:t>content</w:t></w:r></w:p>` +
				`</w:txbxContent></w:drawing></w:r><w:r><w:t>B</w:t></w:r></w:p>`,
			want: "ABox\tcontent\nB",
		},
		{
			name: "tab-stop properties are not content",
			content: `<w:p><w:r><w:t>First</w:t></w:r></w:p>` +
				`<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>` +
				`<w:r><w:t>Second</w:t></w:r></w:p>`,
			want: "First\nSecond",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := SniffAndExtract("resume.docx", docxMediaType, profileTextDOCX(t, test.content))
			if err != nil || got != test.want {
				t.Fatalf("extracted %q, %v; want %q", got, err, test.want)
			}
		})
	}
}

func TestProfileSourceExcerptKeepsUTF8CharactersWhole(t *testing.T) {
	for _, source := range []struct {
		filename, mediaType string
	}{
		{"resume.txt", "text/plain"},
		{"resume.md", "text/markdown"},
		{"resume.docx", docxMediaType},
	} {
		for _, character := range []string{"é", "€", "🙂"} {
			for offset := 1; offset < len(character); offset++ {
				t.Run(fmt.Sprintf("%s/%d-byte-character/%d", source.filename, len(character), offset), func(t *testing.T) {
					prefix := strings.Repeat("x", MaxExtractedBytes-offset)
					input := prefix + character + "suffix"
					body := []byte(input)
					if source.mediaType == docxMediaType {
						body = minimalDOCX(t, input)
					}
					got, err := SniffAndExtract(source.filename, source.mediaType, body)
					if err != nil || !utf8.ValidString(got) || got != prefix {
						t.Fatalf("excerpt valid=%t bytes=%d, error=%v; want %d complete bytes", utf8.ValidString(got), len(got), err, len(prefix))
					}
				})
			}
		}
	}
}

func TestProfileSourceExcerptRetainsCompleteLimitBoundary(t *testing.T) {
	for _, input := range []string{
		strings.Repeat("x", MaxExtractedBytes) + "suffix",
		strings.Repeat("x", MaxExtractedBytes-len("€")) + "€",
	} {
		got, err := SniffAndExtract("resume.txt", "text/plain", []byte(input))
		if err != nil || !utf8.ValidString(got) || got != input[:MaxExtractedBytes] {
			t.Fatalf("complete boundary valid=%t bytes=%d, error=%v", utf8.ValidString(got), len(got), err)
		}
	}
}

func profileTextDOCX(t *testing.T, content string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, part := range []struct {
		name, body string
	}{
		{"[Content_Types].xml", `<?xml version="1.0"?><Types></Types>`},
		{"word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` + content + `</w:body></w:document>`},
	} {
		file, err := writer.Create(part.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte(part.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
