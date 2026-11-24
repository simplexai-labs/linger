import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChannelViewOnlyBanner } from "./room-chat-composer-section";

describe("ChannelViewOnlyBanner", () => {
  it("explains that the iMessage channel Room is view-only", () => {
    render(<ChannelViewOnlyBanner channel="imessage" roomName="iMessage" />);

    const banner = screen.getByTestId("channel-view-only-banner");
    expect(banner).toHaveTextContent("View only");
    expect(banner).toHaveTextContent(
      "Messages are synced from iMessage. Continue this conversation in iMessage.",
    );
  });
});
