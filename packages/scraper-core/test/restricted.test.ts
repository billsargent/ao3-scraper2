import { describe, expect, it } from "vitest";
import { isRestrictedWorkPage } from "../src/index.js";

describe("isRestrictedWorkPage", () => {
  it("detects the AO3 registered-users interstitial", () => {
    const html = [
      "<html><head><title>New Session | Archive of Our Own</title></head><body>",
      '<p class="message">This work is only available to registered users of the Archive.',
      "If you already have an AO3 account, please log in.</p></body></html>",
    ].join("");
    expect(isRestrictedWorkPage(html)).toBe(true);
  });

  it("returns false for a normal work page", () => {
    const html = '<html><head><title>Example Work</title></head><body><h2 class="title heading">Example Work</h2></body></html>';
    expect(isRestrictedWorkPage(html)).toBe(false);
  });

  it("returns false for an empty or unrelated body", () => {
    expect(isRestrictedWorkPage("")).toBe(false);
    expect(isRestrictedWorkPage("<html>Some other page</html>")).toBe(false);
  });
});
