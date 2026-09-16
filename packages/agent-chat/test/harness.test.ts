/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";

import { DETAIL_MAX, IMAGES_MAX, IMAGE_MAX, collectResult } from "../src/host/harness";
import { HARNESS_LABELS, harnessesSettled } from "../src/protocol";
import type { HarnessId, HarnessInfo, HarnessStatus } from "../src/protocol";

const png = (data = "iVBORw0KGgo=") => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

describe("collectResult", () => {
  it("joins text parts and keeps images that fit", () => {
    const result = collectResult([{ type: "text", text: "read it" }, png()]);
    expect(result).toEqual({ output: "read it", images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }] });
  });

  it("returns only images when there is no text", () => {
    expect(collectResult([png()])).toEqual({ images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }] });
  });

  it("leaves a marker for an image over the cap, and for other part kinds", () => {
    const result = collectResult([png("x".repeat(IMAGE_MAX + 1)), { type: "document", source: "not-an-image" }]);
    expect(result).toEqual({ output: "[image]\n[document]" });
  });

  it("keeps at most IMAGES_MAX images", () => {
    const parts = Array.from({ length: IMAGES_MAX + 2 }, () => png());
    const result = collectResult(parts);
    expect(result.images).toHaveLength(IMAGES_MAX);
    expect(result.output).toBe("[image]\n[image]");
  });

  it("truncates long text like any other output", () => {
    const result = collectResult([{ type: "text", text: "y".repeat(DETAIL_MAX + 10) }]);
    expect(result.output).toHaveLength(DETAIL_MAX + 1);
    expect(result.output?.endsWith("…")).toBe(true);
  });

  it("drops empty output", () => {
    expect(collectResult([])).toEqual({});
    expect(collectResult([{ type: "text", text: "  " }])).toEqual({});
  });
});

describe("harnessesSettled", () => {
  const info = (id: HarnessId, status: HarnessStatus): HarnessInfo => ({
    id,
    label: HARNESS_LABELS[id],
    status,
    models: [],
  });

  it("is false for the placeholder the host sends on connect", () => {
    // What `AgentHost.connect` pushes before any probe has run. A gate that
    // reads this as an answer shows its sign-in screen to someone who is
    // already signed in, until the probes land.
    expect(harnessesSettled([info("claude", "checking"), info("codex", "checking")])).toBe(false);
  });

  it("is false while any single harness is still checking", () => {
    expect(harnessesSettled([info("claude", "ready"), info("codex", "checking")])).toBe(false);
  });

  it("is false before any list has arrived", () => {
    expect(harnessesSettled([])).toBe(false);
  });

  it("is true once every harness has a real answer", () => {
    expect(harnessesSettled([info("claude", "ready"), info("codex", "signed-out")])).toBe(true);
    expect(harnessesSettled([info("claude", "not-installed"), info("codex", "error")])).toBe(true);
  });
});
