// Expo app configuration. EAS_PROJECT_ID and LINGER_PUSH_SERVICE_URL are
// build-time values: they are read here when the native project or bundle is
// built, and the app reads them back from Constants.expoConfig.extra.
import type { ExpoConfig } from "expo/config";

// The official Expo project, jeffreybins-team/linger; a fork overrides it.
const officialProjectId = "b761e929-700a-4f74-b987-a184f77866d9";
// The camera and image picker plugins both write this key; they must agree.
const CAMERA_USAGE =
  "Linger uses the camera to scan your computer's pairing code and to take photos you send.";
const MICROPHONE_USAGE =
  "Linger uses the microphone for live conversations and meeting recordings.";
const projectId = process.env.EAS_PROJECT_ID || officialProjectId;
// The official Push Service runs beside the official Relay; a fork that runs
// its own sets LINGER_PUSH_SERVICE_URL.
const pushServiceUrl =
  process.env.LINGER_PUSH_SERVICE_URL || "https://relay.heylinger.com";
// EAS provides the Firebase config as a file environment variable; without it
// the build has no Android push.
const googleServicesFile = process.env.GOOGLE_SERVICES_JSON || undefined;
// The diagnostics receiver, as the desktop release builds it in: official
// builds set it on EAS; a fork, local or self-hosted build has none, which
// hides Send Diagnostics and keeps Save Diagnostics.
const diagnosticsUploadUrl =
  process.env.LINGER_DIAGNOSTICS_UPLOAD_URL || undefined;

const config: ExpoConfig = {
  name: "Linger",
  slug: "linger",
  owner: "jeffreybins-team",
  scheme: "linger",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: "com.heylinger.linger",
    supportsTablet: false,
    infoPlist: {
      NSLocalNetworkUsageDescription:
        "Linger connects directly to your computer on this Wi-Fi network.",
      NSMicrophoneUsageDescription: MICROPHONE_USAGE,
      // The LAN route is ws:// to a private address. The session inside is
      // end-to-end encrypted with the computer's pinned key, so transport
      // security is not what protects it.
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      UIBackgroundModes: ["audio", "remote-notification"],
      // The only encryption is the Noise session (Curve25519,
      // ChaCha20-Poly1305), standard algorithms the export rules exempt.
      ITSAppUsesNonExemptEncryption: false,
      // Lets Reanimated run at 120 Hz on ProMotion iPhones.
      CADisableMinimumFrameDurationOnPhone: true,
    },
  },
  android: {
    package: "com.heylinger.linger",
    ...(googleServicesFile ? { googleServicesFile } : {}),
    adaptiveIcon: {
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    permissions: [
      "android.permission.RECORD_AUDIO",
      "android.permission.CAMERA",
      "android.permission.POST_NOTIFICATIONS",
    ],
  },
  plugins: [
    "expo-router",
    [
      "expo-camera",
      {
        cameraPermission: CAMERA_USAGE,
        // The camera plugin owns this key: false would delete the
        // microphone string the voice features need, and App Store
        // processing rejects a build without it.
        microphonePermission: MICROPHONE_USAGE,
        recordAudioAndroid: false,
      },
    ],
    [
      "expo-image-picker",
      {
        cameraPermission: CAMERA_USAGE,
        photosPermission:
          "Linger lets you pick photos and videos to send in a chat.",
        microphonePermission: false,
      },
    ],
    "expo-secure-store",
    "expo-notifications",
    [
      "react-native-audio-api",
      {
        // A meeting keeps recording with the screen locked: background audio
        // on iOS, a microphone foreground service with its notification on
        // Android, started while the app is in the foreground.
        iosBackgroundMode: true,
        androidForegroundService: true,
        androidFSTypes: ["microphone"],
        androidPermissions: [
          "android.permission.FOREGROUND_SERVICE",
          "android.permission.FOREGROUND_SERVICE_MICROPHONE",
        ],
      },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        imageWidth: 160,
        backgroundColor: "#fdfdfc",
      },
    ],
    [
      "expo-build-properties",
      {
        // The LAN route is ws:// to the computer's private address. Every
        // message on it is a Noise transport message encrypted end to end
        // with the computer's pinned key, so cleartext WebSocket transport
        // exposes nothing; Android blocks it unless this is on.
        android: { usesCleartextTraffic: true },
      },
    ],
  ],
  extra: {
    ...(projectId ? { eas: { projectId } } : {}),
    pushServiceUrl,
    ...(diagnosticsUploadUrl ? { diagnosticsUploadUrl } : {}),
  },
};

export default config;
