// Expo's Metro defaults, plus .html as an asset: the offline file viewer
// (assets/viewer/viewer.html) ships inside the app and opens in a WebView.
import expoMetroConfig from "expo/metro-config";

const config = expoMetroConfig.getDefaultConfig(import.meta.dirname);
config.resolver.assetExts.push("html");

export default config;
