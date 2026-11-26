// Loaded first from index.ts, before any screen formats a message.
import { installPluralRules } from "./plural-rules";

installPluralRules(globalThis);
