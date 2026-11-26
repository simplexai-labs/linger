// Shows a downloaded file in the offline viewer page (viewer/main.ts) inside
// a WebView, so PDF, Office, tables, HTML, Mermaid and more render in the app
// with the desktop's own libraries. The page is copied beside the file and
// may read only that directory; it never loads anything off the phone.
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import viewerPage from "../../assets/viewer/viewer.html";
import { colors } from "../theme";

/** The viewer page's renderers; see viewer/main.ts. */
export type WebKind =
  | "pdf"
  | "office"
  | "csv"
  | "tsv"
  | "mermaid"
  | "html"
  | "image"
  | "text"
  | "video";

/** The viewer page, copied beside the file it shows. */
async function pageBeside(file: File): Promise<File> {
  const asset = Asset.fromModule(viewerPage);
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error("Viewer page missing");
  // The hash names the page, so an app update replaces an older copy.
  const page = new File(
    file.parentDirectory,
    `viewer-${asset.hash ?? "page"}.html`,
  );
  if (!page.exists) await new File(asset.localUri).copy(page);
  return page;
}

function allowed(url: string, directory: string): boolean {
  return (
    url.startsWith(directory) ||
    url.startsWith("about:") ||
    url.startsWith("blob:") ||
    url.startsWith("data:")
  );
}

export function FileViewer(props: {
  readonly file: File;
  readonly kind: WebKind;
  readonly filename: string;
  readonly mediaType: string;
  /** "zh-CN" for the Chinese interface; Office toolbars follow it. */
  readonly language: string;
  readonly onFailed: () => void;
  /** The table showed only its first rows. */
  readonly onTruncated?: (rows: number) => void;
}) {
  const { file, onFailed, onTruncated } = props;
  const [page, setPage] = useState<File>();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void pageBeside(file).then(
      (next) => {
        if (!cancelled) setPage(next);
      },
      () => {
        if (!cancelled) onFailed();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [file, onFailed]);

  if (!page)
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.muted} />
      </View>
    );

  const directory = file.parentDirectory.uri;
  const fragment = new URLSearchParams({
    kind: props.kind,
    src: file.name,
    name: props.filename,
    type: props.mediaType,
    lang: props.language,
  }).toString();

  const onMessage = (event: WebViewMessageEvent) => {
    let message: { kind?: unknown; rows?: unknown };
    try {
      message = JSON.parse(event.nativeEvent.data) as typeof message;
    } catch {
      return;
    }
    if (message.kind === "loaded") setLoaded(true);
    else if (message.kind === "failed") onFailed();
    else if (message.kind === "truncated" && typeof message.rows === "number")
      onTruncated?.(message.rows);
  };

  return (
    <View style={styles.fill}>
      <WebView
        source={{ uri: `${page.uri}#${fragment}` }}
        originWhitelist={["file://*", "about:*", "blob:*", "data:*"]}
        allowingReadAccessToURL={directory}
        allowFileAccess
        allowFileAccessFromFileURLs
        onShouldStartLoadWithRequest={(request) =>
          allowed(request.url, directory)
        }
        setSupportMultipleWindows={false}
        allowsInlineMediaPlayback
        onMessage={onMessage}
        onError={onFailed}
        style={styles.fill}
      />
      {loaded ? null : (
        <View style={styles.cover} pointerEvents="none">
          <ActivityIndicator color={colors.muted} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.canvas },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  cover: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.canvas,
  },
});
