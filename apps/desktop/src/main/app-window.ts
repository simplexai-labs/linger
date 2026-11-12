// Which window opening Linger again shows (a second launch, the Dock, the
// tray): setup while it is open or until this computer is connected, so a
// setup closed part way, whose installation keeps running, comes back where
// it was; the main window after. Without a server the main window could only
// ask for a team's server address.
export function appWindow(state: {
  readonly enrolled: boolean;
  readonly setupOpen: boolean;
}): "setup" | "main" {
  return state.setupOpen || !state.enrolled ? "setup" : "main";
}
