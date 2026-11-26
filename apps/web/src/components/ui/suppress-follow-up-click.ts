let clearSuppressedClick: (() => void) | null = null;

/**
 * Swallows the single `click` paired with an outside-dismissal `pointerdown` so
 * dismissing a popup never activates underlying controls, modal backdrops, or
 * wrapping `<label>` activation. Shared with the popovers that keep their own
 * dismissal listener instead of `useAnchoredSelectPopup`.
 */
export function suppressFollowUpClick(originEvent: PointerEvent) {
  clearSuppressedClick?.();
  if (typeof window === "undefined") return;

  const originTarget =
    originEvent.target instanceof Node ? originEvent.target : null;
  const downPointerId = originEvent.pointerId;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    if (cleanupTimer !== undefined) {
      clearTimeout(cleanupTimer);
      cleanupTimer = undefined;
    }
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerCancel, true);
    window.removeEventListener("pointerdown", onNextPointerDown, true);
    window.removeEventListener("blur", cleanup);
    if (clearSuppressedClick === cleanup) {
      clearSuppressedClick = null;
    }
  };

  const matchesPointer = (event: PointerEvent) =>
    downPointerId === undefined ||
    event.pointerId === undefined ||
    event.pointerId === downPointerId;

  const isFollowUpTarget = (clickTarget: EventTarget | null) =>
    originTarget !== null &&
    originTarget.isConnected &&
    clickTarget instanceof Node &&
    clickTarget.contains(originTarget);

  const onClick = (event: MouseEvent) => {
    const shouldSuppress = isFollowUpTarget(event.target);
    cleanup();
    if (shouldSuppress) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!matchesPointer(event)) return;
    if (cleanupTimer !== undefined) {
      clearTimeout(cleanupTimer);
    }
    // Touch browsers may emit compatibility click up to ~300ms after pointerup;
    // a fast second tap still clears immediately via onNextPointerDown.
    cleanupTimer = setTimeout(cleanup, event.pointerType === "touch" ? 400 : 0);
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (!matchesPointer(event)) return;
    cleanup();
  };

  const onNextPointerDown = (event: PointerEvent) => {
    if (event === originEvent) return;
    cleanup();
  };

  window.addEventListener("click", onClick, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerCancel, true);
  window.addEventListener("pointerdown", onNextPointerDown, true);
  window.addEventListener("blur", cleanup);
  clearSuppressedClick = cleanup;
}
