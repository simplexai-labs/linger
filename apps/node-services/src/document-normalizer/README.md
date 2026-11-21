# Document source normalization

`normalizeDocumentContent` converts supported local source bytes to canonical
Markdown. Source selection uses a recognized MIME essence first, then the
filename and representation format. Generic or unspecified media types retain
those fallbacks.

Text sources accept MIME metadata such as CSV's `header=present` independently
of the character encoding. Parameters use MIME quoted-string parsing, so
`charset="UTF-8"` and semicolons inside quoted values are supported. An explicit
charset must be `utf-8` or `utf8`, case-insensitively; other declared encodings
are unsupported. Regardless of metadata, text bytes must pass strict UTF-8
decoding before format-specific conversion.

HTML uses the existing Office converter to preserve inline text, links, lists,
tables and code blocks as Markdown. HTML runs in the shared bounded normalization
worker, with remote assets, image extraction and OCR disabled. Plain text and
Markdown retain their in-process path. HTML headings omit generated anchor labels
so CommonMark readers do not display them as literal text.

The response announces this behavior as normalizer version 3. A version header
change does not enqueue existing Document Versions for normalization; their
stored Markdown remains until a text sync runs again.

CSV and TSV records accept LF, CRLF, and CR line endings. Line breaks inside quoted fields remain cell content; a CRLF pair outside quotes ends exactly one record.
