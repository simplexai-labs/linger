import { useEffect, useState } from "react";

export type DesktopLocalAccountSignIn =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

// The desktop app's sign-in with the owner account of the Linger it installed
// on this computer (`window.lingerDesktop.localAccount`). The desktop reads
// the account file and signs this window in itself; the page never sees the
// password.
export interface DesktopLocalAccount {
  available(): Promise<boolean>;
  signIn(): Promise<DesktopLocalAccountSignIn>;
}

function desktopLocalAccount(): DesktopLocalAccount | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as { lingerDesktop?: { localAccount?: DesktopLocalAccount } })
        .lingerDesktop?.localAccount;
}

// How often the page asks again whether the desktop can still sign it in:
// the local services can stop, or another program take their port, while
// the page is open.
export const DESKTOP_LOCAL_ACCOUNT_CHECK_MS = 15_000;

/**
 * The account sign-in when this page runs in the desktop app and shows the
 * Linger installed on this computer, while its server answers as itself;
 * undefined in a browser, in older desktop builds and for any other server.
 * Asked again every DESKTOP_LOCAL_ACCOUNT_CHECK_MS and whenever the window
 * comes back into view.
 */
export function useDesktopLocalAccount(): DesktopLocalAccount | undefined {
  const [account, setAccount] = useState<DesktopLocalAccount>();
  useEffect(() => {
    const api = desktopLocalAccount();
    if (!api) return;
    let active = true;
    let checking = false;
    const check = () => {
      if (checking || document.visibilityState === "hidden") return;
      checking = true;
      void api
        .available()
        .catch(() => false)
        .then((available) => {
          if (active) setAccount(available ? api : undefined);
        })
        .finally(() => {
          checking = false;
        });
    };
    check();
    const timer = window.setInterval(check, DESKTOP_LOCAL_ACCOUNT_CHECK_MS);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return account;
}
