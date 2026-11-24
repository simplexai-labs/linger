import { defineMessages } from "@/i18n/messages";

/** The panel that shows a web page beside a Room. */
export const urlPreviewMessages = defineMessages("urlPreview", {
  forward: "Forward",
  reload: "Reload",
  urlAddress: "URL address",
  enterUrl: "Enter URL",
  openInNewTab: "Open in new tab",
  invalidUrl: "Enter a valid HTTP(S) URL without credentials.",
  enterUrlToPreview: "Enter a URL to preview.",
  openInBrowserTab: "Open this address in a browser tab to view it.",
  openSiteInNewTab: "Open this site in a new tab",
  siteRefusesFrame: "{host} does not allow being shown in the app.",
  checkingSite: "Checking whether this site can be shown here.",
  // The name of the frame that shows the page.
  previewTitle: "Preview {url}",
});
