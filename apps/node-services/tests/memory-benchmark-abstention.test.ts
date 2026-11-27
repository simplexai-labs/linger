import { describe, expect, it } from "vitest";

import {
  calibrateDeclinedJudge,
  judgeDeclined,
  needsDeclinedVerdict,
  summarizeAbstention,
} from "../scripts/memory-benchmark/abstention.js";
import type { ModelCallRequest } from "../src/runtime-model-call.js";
import { stubModelCall } from "./model-call-stub.js";

const right = { judgment: { correct: true } };
const wrong = { judgment: { correct: false } };

describe("memory benchmark abstention figures", () => {
  it("reports each side of the trade-off separately", () => {
    expect(
      summarizeAbstention([
        { unanswerable: true, ...right },
        { unanswerable: true, ...right },
        { unanswerable: true, ...wrong },
        { unanswerable: true, ...wrong },
        { unanswerable: false, ...right },
        { unanswerable: false, ...right },
        { unanswerable: false, ...wrong, declined: { declined: true } },
        { unanswerable: false, ...wrong, declined: { declined: false } },
        { unanswerable: false, ...wrong, declined: { declined: false } },
      ]),
    ).toEqual({
      unanswerable: 4,
      correct_abstention: 0.5,
      answerable: 5,
      false_abstention: 0.2,
    });
  });

  it("never counts a correct answer as declined", () => {
    expect(
      summarizeAbstention([
        { unanswerable: false, ...right, declined: { declined: true } },
      ]).false_abstention,
    ).toBe(0);
  });

  it("counts an answer that failed before judging in the total only", () => {
    expect(
      summarizeAbstention([
        { unanswerable: true },
        { unanswerable: true, ...right },
        { unanswerable: false },
        { unanswerable: false, ...wrong, declined: { declined: true } },
      ]),
    ).toEqual({
      unanswerable: 2,
      correct_abstention: 0.5,
      answerable: 2,
      false_abstention: 0.5,
    });
  });

  it("gives no share for a side that has no questions", () => {
    expect(summarizeAbstention([{ unanswerable: false, ...right }])).toEqual({
      unanswerable: 0,
      correct_abstention: null,
      answerable: 1,
      false_abstention: 0,
    });
    expect(summarizeAbstention([{ unanswerable: true, ...right }])).toEqual({
      unanswerable: 1,
      correct_abstention: 1,
      answerable: 0,
      false_abstention: null,
    });
  });

  it("gives no false abstention share when a wrong answer was never classified", () => {
    expect(
      summarizeAbstention([
        { unanswerable: true, ...right },
        { unanswerable: false, ...wrong },
        { unanswerable: false, ...wrong, declined: { declined: true } },
      ]),
    ).toEqual({
      unanswerable: 1,
      correct_abstention: 1,
      answerable: 2,
      false_abstention: null,
    });
  });
});

describe("memory benchmark declined verdicts still to ask for", () => {
  it("asks only for answerable questions graded wrong without a verdict", () => {
    expect(needsDeclinedVerdict({ unanswerable: false, ...wrong })).toBe(true);
    expect(
      needsDeclinedVerdict({
        unanswerable: false,
        ...wrong,
        declined: { declined: false },
      }),
    ).toBe(false);
    expect(needsDeclinedVerdict({ unanswerable: false, ...right })).toBe(false);
    expect(needsDeclinedVerdict({ unanswerable: true, ...wrong })).toBe(false);
    expect(needsDeclinedVerdict({ unanswerable: false })).toBe(false);
  });
});

describe("memory benchmark declined-answer judge", () => {
  it("asks for a structured verdict on the question and the answer", async () => {
    const requests: ModelCallRequest[] = [];
    const modelCall = stubModelCall({
      call: (request) => {
        requests.push(request);
        return Promise.resolve({
          output: { declined: true, reason: "No answer is given." },
          model: "judge",
        });
      },
    });

    await expect(
      judgeDeclined(
        modelCall,
        "product:1:q7",
        "Where does Mira work?",
        "That was never mentioned.",
      ),
    ).resolves.toEqual({ declined: true, reason: "No answer is given." });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: "memory",
      key: "benchmark:declined:product:1:q7",
      schemaName: "declined",
      outputSchema: { required: ["declined", "reason"] },
    });
    expect(requests[0]?.input).toContain("Where does Mira work?");
    expect(requests[0]?.input).toContain("That was never mentioned.");
  });

  it("passes calibration when declined and committed answers are told apart", async () => {
    const verdicts = [true, true, false, false];
    const modelCall = stubModelCall({
      call: () =>
        Promise.resolve({
          output: { declined: verdicts.shift(), reason: "" },
          model: "judge",
        }),
    });

    await expect(calibrateDeclinedJudge(modelCall)).resolves.toBeUndefined();
    expect(verdicts).toEqual([]);
  });

  it("fails calibration when a hedged answer is called declined", async () => {
    const modelCall = stubModelCall({
      call: () =>
        Promise.resolve({
          output: { declined: true, reason: "It sounds unsure." },
          model: "judge",
        }),
    });

    await expect(calibrateDeclinedJudge(modelCall)).rejects.toThrow(
      "abstention control 2 (It sounds unsure.)",
    );
  });
});
