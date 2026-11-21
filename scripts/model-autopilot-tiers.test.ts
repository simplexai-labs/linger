import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { expect, it } from "vitest";

const readmeUrl = new URL("../README.md", import.meta.url);
const readme = readFileSync(readmeUrl, "utf8");
const image = JSDOM.fragment(readme).querySelector<HTMLImageElement>(
  'a[href="docs/local-inference.md#planning"] img',
)!;
const generated = readme.match(
  /<!-- BEGIN GENERATED: public-tiers tiers,[\s\S]*?<!-- END GENERATED: public-tiers tiers -->/,
)![0];
const rows = JSDOM.fragment(generated).querySelector("table")!.rows;
const tiers = Array.from(rows)
  .slice(1)
  .map(({ cells }) => ({
    hardware: cells[0].textContent.trim(),
    model: cells[1].textContent.trim(),
    score: cells[3].textContent.trim(),
  }));
const nonDefaultNote = /†\s*[^.†]*\bnot\b[^.†]*\bdefault\b/i;

it("describes each measured tier in the Model Autopilot image alt text", () => {
  expect(tiers.length).toBeGreaterThan(0);
  const entries = tiers.map(
    ({ hardware, model, score }) => `${hardware}: ${model}, ${score}`,
  );
  expect(image.alt).toContain(entries.join("; ") + ".");
  expect(image.alt).toMatch(nonDefaultNote);
});

it("shows the generated models, scores and non-default note in the linked graphic", () => {
  const src = image.getAttribute("src")!;
  expect(src).toMatch(/\.svg$/);
  const svg = new JSDOM(readFileSync(new URL(src, readmeUrl), "utf8"), {
    contentType: "image/svg+xml",
  }).window.document;
  const ticks = Array.from(svg.querySelectorAll(".tick text"), (tick) => ({
    score: Number(tick.textContent),
    x: Number(tick.getAttribute("x")),
  }));
  const first = ticks[0];
  const last = ticks.at(-1)!;
  const unitsPerPoint = (last.x - first.x) / (last.score - first.score);
  const tierRows = svg.querySelectorAll("g.tier");
  expect(tierRows).toHaveLength(tiers.length);
  for (const [index, { hardware, model, score }] of tiers.entries()) {
    const row = tierRows[index];
    expect(row.querySelector(".hardware")?.textContent).toBe(hardware);
    expect(row.querySelector(".model")?.textContent).toBe(model);
    expect(row.querySelector(".score")?.textContent).toBe(score);
    const markers = row.querySelectorAll("circle.score-point");
    expect(markers).toHaveLength(score === "Not ranked" ? 0 : 1);
    if (markers.length) {
      const x = first.x + (Number(score) - first.score) * unitsPerPoint;
      expect(Number(markers[0].getAttribute("cx"))).toBeCloseTo(x, 1);
    }
  }
  const labels = Array.from(svg.querySelectorAll("text"), (node) =>
    node.textContent.trim(),
  );
  expect(labels.join(" ")).toMatch(nonDefaultNote);
});
