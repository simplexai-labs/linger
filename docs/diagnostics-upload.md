# Diagnostics upload

When setup or the local services fail, the desktop app can send its
diagnostics zip to a receiver instead of asking the person to mail the file.
This page is the contract a receiver implements, so a team that runs its own
Linger can collect reports too.

## In the app

Send Diagnostics shows on the start failure page and in the tray menu, but
only while a receiver is set up; on the setup page's failed step
("Installation stopped") it is the one Report issue button, which saves the
zip to Downloads instead when no receiver is set up. The app builds the same redacted zip as Save Diagnostics
(see `apps/desktop/src/main/diagnostics.ts`): credential files are never
included, secret-looking values are replaced with `[REDACTED]`, and the home
folder path is replaced with `~`. It then lists every file, the size and the
receiver's host and uploads nothing until the person chooses Send. The
receiver's report id is shown at the end with Copy Report ID; the person gives
it to support. A failed upload keeps the zip for Try Again; the zip is deleted
once sent or declined.

The receiver is `diagnosticsUploadUrl` in the desktop `config.json` (in the
app's user data folder). It must be `https`, or `http` to `localhost`,
`127.0.0.1` or `[::1]` while developing a receiver; any other value is
ignored. Without it, the app uses the hosted receiver that the release
pipeline builds in (`LINGER_DIAGNOSTICS_UPLOAD_URL`, see
[desktop-release.md](desktop-release.md)); a build without one, such as a
fork's, a local or a self-hosted build, hides Send Diagnostics.

```json
{ "diagnosticsUploadUrl": "https://diagnostics.example.com/v1/reports" }
```

## Protocol `linger.diagnostics-upload/v1`

Two requests. The receiver never has to accept the zip itself: it can hand
out a presigned object storage URL.

### 1. Ask for an upload

```http
POST /v1/reports HTTP/1.1
Content-Type: application/json

{
  "schema": "linger.diagnostics-upload/v1",
  "size": 183204,
  "sha256": "<hex SHA-256 of the zip>",
  "client": {
    "name": "linger-desktop",
    "version": "0.16.20",
    "platform": "darwin-arm64"
  }
}
```

The receiver answers `200` or `201`:

```json
{
  "schema": "linger.diagnostics-upload/v1",
  "reportId": "LD-7K3Q9XPM",
  "upload": {
    "method": "PUT",
    "url": "https://storage.example.com/reports/LD-7K3Q9XPM.zip?X-Amz-...",
    "headers": { "content-type": "application/zip" }
  }
}
```

- `reportId`: 4 to 64 letters, digits and `-`, starting with a letter or
  digit. It is what the person reads out, so keep it short, and random
  enough that reports cannot be guessed.
- `upload.url`: `https` (or loopback `http`, as above). The app does not
  follow redirects on the first request.
- `upload.headers`: sent as given with the upload, except `Host`,
  `Content-Length`, `Transfer-Encoding` and `Connection`, which the app sets.

### 2. Upload the zip

```http
PUT <upload.url> HTTP/1.1
Content-Type: application/zip
Content-Length: 183204

<zip bytes>
```

Any `2xx` completes the report. There is no further request.

### Errors

Answer the first request with the repository's error envelope,
`{"error": {"code": "...", "message": "..."}}`; the app shows the message.

| Status | Meaning                   | The app                                  |
| ------ | ------------------------- | ---------------------------------------- |
| `413`  | `size` is over your limit | No Try Again; suggests Save Diagnostics  |
| `429`  | Rate limited              | Try Again; shows `Retry-After` (seconds) |
| `5xx`  | Receiver failure          | Try Again                                |
| other  | Refused                   | No Try Again                             |

A `403` or `5xx` on the upload offers Try Again with the same zip and a new
first request. The app refuses zips over 50 MB itself.

## Running a receiver

A receiver should:

- accept the first request without sign-in (the person may be failing to set
  up the server they would sign in to) and limit it per client address;
- refuse `size` over its limit (50 MB is the app's own) and sign the
  presigned PUT for exactly that `Content-Length` and
  `Content-Type: application/zip`, valid for a few minutes;
- store reports privately (no public read), encrypted at rest, and delete
  them after a fixed time such as 30 days;
- record `reportId`, the `client` fields, `sha256` and the time, so support
  can find a report by id and check the zip.

With S3, the first request is a few lines around `PutObjectCommand` and
`getSignedUrl` from the AWS SDK:

```ts
const reportId = `LD-${randomBytes(5).toString("hex").toUpperCase()}`;
const url = await getSignedUrl(
  s3,
  new PutObjectCommand({
    Bucket: bucket,
    Key: `reports/${new Date().toISOString().slice(0, 10)}/${reportId}.zip`,
    ContentType: "application/zip",
    ContentLength: body.size,
    Metadata: { sha256: body.sha256, version: body.client.version },
  }),
  {
    expiresIn: 300,
    signableHeaders: new Set(["content-type", "content-length"]),
  },
);
// 201 { schema, reportId, upload: { method: "PUT", url,
//        headers: { "content-type": "application/zip" } } }
```

Pair it with a bucket lifecycle rule that expires `reports/` after 30 days and
aborts incomplete multipart uploads.
