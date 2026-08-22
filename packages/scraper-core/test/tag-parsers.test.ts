import { describe, expect, it } from "vitest";
import { parseTagSearchHtml, parseTagWorksHtml, tagWorksUrl } from "../src/index.js";

const tagSearchHtml = [
  "<html><head><title>Search results | Archive of Our Own</title></head><body>",
  '<h3 class="heading">Categories</h3>',
  '<ol class="tag index group">',
  '  <li class="tag"><a href="/tags/M%2FM/works" class="tag">M/M</a> (98765)</li>',
  '  <li class="tag"><a href="/tags/F%2FF/works" class="tag">F/F</a> (54321)</li>',
  "</ol>",
  '<h3 class="heading">Fandoms</h3>',
  '<ol class="tag index group">',
  '  <li class="tag"><a href="/tags/Harry%20Potter/works" class="tag">Harry Potter</a> (43210)</li>',
  "</ol>",
  "</body></html>",
].join("");

const tagWorksHtml = [
  '<ol class="work index group">',
  '  <li class="work blurb group" role="article" id="work_12345">',
  '    <h4 class="heading"><a href="/works/12345">First Work Title</a></h4>',
  "  </li>",
  '  <li class="work blurb group" role="article" id="work_67890">',
  '    <h4 class="heading"><a href="/works/67890">Second Work</a></h4>',
  "  </li>",
  "</ol>",
].join("");

describe("parseTagSearchHtml", () => {
  it("extracts name, slug, type and usage count grouped by section heading", () => {
    const results = parseTagSearchHtml(tagSearchHtml);
    expect(results).toEqual([
      { name: "M/M", slug: "M%2FM", type: "Category", worksCount: 98765 },
      { name: "F/F", slug: "F%2FF", type: "Category", worksCount: 54321 },
      { name: "Harry Potter", slug: "Harry%20Potter", type: "Fandom", worksCount: 43210 },
    ]);
  });

  it("dedupes repeated slugs and tolerates missing counts", () => {
    const html = '<h3 class="heading">Relationships</h3><ol class="tag index group"><li class="tag"><a href="/tags/A%2FB/works" class="tag">A/B</a> <a href="/tags/A%2FB/works" class="tag">A/B</a> (10)</li></ol>';
    expect(parseTagSearchHtml(html)).toEqual([{ name: "A/B", slug: "A%2FB", type: "Relationship", worksCount: 10 }]);
  });

  it("returns an empty list for pages without tag links", () => {
    expect(parseTagSearchHtml("<html><body><p>No results</p></body></html>")).toEqual([]);
  });
});

describe("parseTagWorksHtml", () => {
  it("extracts work IDs and titles from the tag listing", () => {
    expect(parseTagWorksHtml(tagWorksHtml)).toEqual([
      { sourceWorkId: "12345", title: "First Work Title" },
      { sourceWorkId: "67890", title: "Second Work" },
    ]);
  });

  it("ignores non-work links and returns an empty list when empty", () => {
    const html = '<li class="work blurb"><h4 class="heading"><a href="/users/Bob/pseuds/Bob">Bob</a></h4></li>';
    expect(parseTagWorksHtml(html)).toEqual([]);
  });
});

describe("tagWorksUrl", () => {
  it("builds the paginated tag works URL", () => {
    expect(tagWorksUrl("https://archiveofourown.org", "M%2FM", 1)).toBe("https://archiveofourown.org/tags/M%2FM/works");
    expect(tagWorksUrl("https://archiveofourown.org", "M%2FM", 3)).toBe("https://archiveofourown.org/tags/M%2FM/works?page=3");
  });
});
