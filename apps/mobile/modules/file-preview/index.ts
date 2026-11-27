// The system viewer for files the app does not render itself: Quick Look on
// iOS, the app the system picks for the type on Android.
import { requireNativeModule } from "expo";

interface FilePreviewNative {
  canOpen(uri: string): boolean;
  open(uri: string, title?: string, mediaType?: string): Promise<void>;
}

const native = requireNativeModule<FilePreviewNative>("FilePreview");

export function canOpenFile(uri: string): boolean {
  return native.canOpen(uri);
}

/** Resolves when the viewer closes on iOS, or once it opens on Android. */
export function openFile(
  uri: string,
  title?: string,
  mediaType?: string,
): Promise<void> {
  return native.open(uri, title, mediaType);
}
