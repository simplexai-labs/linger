import { z } from "zod";
import { teamHubIdSchema } from "../message-segments.js";

export const roomHandoffInputSchema = z
  .object({
    handoff_id: teamHubIdSchema
      .optional()
      .describe("Existing handoff to continue with the Human's answer."),
    room_id: teamHubIdSchema.describe(
      "Another Room where you and your Human are both members.",
    ),
    instruction: z
      .string()
      .min(1)
      .max(8000)
      .refine((value) => value.trim() !== "", "Instruction must not be blank.")
      .describe(
        "Self-contained instruction for you in that Room; hidden from its timeline.",
      ),
  })
  .strict()
  .describe("Arguments accepted by the hand_off_to_room tool.");

export const roomHandoffOutputSchema = z
  .object({
    duplicate_request: z
      .boolean()
      .describe(
        "Whether TeamHub returned an earlier handoff of this operation.",
      ),
    reason: z
      .string()
      .min(1)
      .optional()
      .describe("Public explanation of a committed replay."),
    accepted: z.literal(true).describe("Whether TeamHub posted the handoff."),
    inbox_id: z
      .string()
      .regex(/^room:[A-Za-z0-9][A-Za-z0-9_-]*$/u)
      .describe("Inbox of the Room that received the handoff."),
    handoff_id: teamHubIdSchema.describe("Identifier of the hidden handoff."),
  })
  .strict()
  .describe("Successful result returned by the hand_off_to_room tool.");

export const roomHandoffSchema = {
  input: roomHandoffInputSchema,
  output: roomHandoffOutputSchema,
};
