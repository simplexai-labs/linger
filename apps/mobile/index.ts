// Noble's key generation reads crypto.getRandomValues, which React Native
// does not provide; the polyfill must load before any module that uses it.
import "react-native-get-random-values";
// Hermes has no Intl.PluralRules, which plural messages need.
import "./src/i18n/install-plural-rules";
import "expo-router/entry";
