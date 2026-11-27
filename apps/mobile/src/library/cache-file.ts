// Files from the computer the phone holds only while a screen shows them:
// one per Document Version under the computer's cache directory, streamed
// to disk so a large file never sits in memory.
import { Directory, File, Paths } from "expo-file-system";

import { computerDirectory } from "../computer/store";
import { HttpError } from "../session/http";
import { SessionClosed, type PhoneSession } from "../session/session";

function extension(filename: string): string {
  const match = /\.[A-Za-z0-9]{1,8}$/.exec(filename);
  return match ? match[0].toLowerCase() : "";
}

/** An empty cache file for this version, named so viewers know its type. */
export function freshCacheFile(
  hostId: string,
  versionId: string,
  filename: string,
): File {
  const directory = new Directory(
    Paths.cache,
    ...computerDirectory(hostId).split("/"),
    "files",
  );
  // The version ID can come from a link; anything but an ID could name a
  // path outside this directory, which the line below would delete.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(versionId))
    throw new Error("Not a Document Version ID");
  directory.create({ intermediates: true, idempotent: true });
  const file = new File(directory, `${versionId}${extension(filename)}`);
  if (file.exists) file.delete();
  file.create();
  return file;
}

/** Streams a response body into a file without holding it in memory. */
export function downloadToFile(
  session: PhoneSession,
  path: string,
  file: File,
  onProgress: (bytes: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let status = 0;
    let received = 0;
    let writes: Promise<void> = Promise.resolve();
    const stream = session.openRequest(
      { method: "GET", path, headers: {} },
      {
        onResponse: (head) => {
          status = head.status;
        },
        onData: (chunk) => {
          if (status >= 400) return;
          const copy = chunk.slice();
          received += copy.length;
          onProgress(received);
          writes = writes.then(() => file.write(copy, { append: true }));
        },
        onEnd: () => {
          writes.then(() => {
            if (status >= 400)
              reject(
                new HttpError(status, `HTTP_${status}`, "Download failed"),
              );
            else resolve();
          }, reject);
        },
        onReset: (code) => reject(new SessionClosed(code)),
      },
    );
    stream.end();
  });
}
