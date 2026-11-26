import { useSyncExternalStore } from "react";

import {
  getTranslation,
  subscribeTranslation,
  type Translation,
} from "./language";

/** The language on screen; a component re-renders when it changes. */
export function useTranslation(): Translation {
  return useSyncExternalStore(subscribeTranslation, getTranslation);
}
