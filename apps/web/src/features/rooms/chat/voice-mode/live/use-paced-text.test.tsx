import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resetVoicePace,
  usePacedText,
  type VoiceLinePacing,
} from "./voice-live-pacing";

afterEach(() => {
  resetVoicePace();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const element = { current: null };

function renderPaced(text: string, pacing: VoiceLinePacing | undefined) {
  return renderHook(
    (props: {
      text: string;
      pacing: VoiceLinePacing | undefined;
      tick: number;
    }) => usePacedText(props.text, props.pacing, element),
    { initialProps: { text, pacing, tick: 0 } },
  );
}

describe("usePacedText", () => {
  it("starts a spoken line empty and reveals it as time passes", async () => {
    vi.useFakeTimers();
    const view = renderPaced("Two meetings today.", "speaking");
    expect(view.result.current).toBe("");
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    // No reply meter: the voice counts as playing, at the default pace of
    // about seven characters a second.
    expect("Two meetings today.".startsWith(view.result.current)).toBe(true);
    expect(view.result.current.length).toBeGreaterThanOrEqual(6);
    expect(view.result.current.length).toBeLessThanOrEqual(7);
  });

  it("shows a line it did not see spoken in full at once", () => {
    expect(renderPaced("Earlier reply.", undefined).result.current).toBe(
      "Earlier reply.",
    );
  });

  it("shows the rest once the voice ended, and keeps a cut line as it was", async () => {
    vi.useFakeTimers();
    const ended = renderPaced("Two meetings today.", "speaking");
    await act(() => vi.advanceTimersByTimeAsync(500));
    ended.rerender({ text: "Two meetings today.", pacing: undefined, tick: 0 });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(ended.result.current).toBe("Two meetings today.");

    const cut = renderPaced("Two meetings today.", "speaking");
    await act(() => vi.advanceTimersByTimeAsync(500));
    cut.rerender({ text: "Two meetings today.", pacing: "cut", tick: 0 });
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(cut.result.current).toBe("Two");
  });

  it("keeps one frame loop through new words and unrelated renders", async () => {
    vi.useFakeTimers();
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    const view = renderPaced("Two", "speaking");
    await act(() => vi.advanceTimersByTimeAsync(100));
    view.rerender({ text: "Two meetings", pacing: "speaking", tick: 1 });
    view.rerender({ text: "Two meetings today.", pacing: "said", tick: 2 });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(cancel).not.toHaveBeenCalled();
    view.unmount();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
