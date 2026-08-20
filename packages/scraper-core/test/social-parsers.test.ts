import { describe, expect, it } from "vitest";
import { nextPageUrl, parseBookmarksHtml, parseCommentsHtml, parseKudosHtml } from "../src/index.js";

const origin = "https://archiveofourown.org";

describe("comment parser", () => {
  const html = `
    <div id="comments_placeholder">
      <ol class="thread">
        <li class="odd comment group user-25070749" id="comment_1038237076">
          <h4 class="heading byline">
            <a href="/users/Silvigor/pseuds/Silvigor">Silvigor</a>
            <span class="parent">on <a href="/works/51621847/chapters/193562681">Chapter 430</a></span>
            <span class="posted datetime"><abbr class="day" title="Saturday">Sat</abbr> <span class="date">15</span> <abbr class="month" title="November">Nov</abbr> <span class="year">2025</span> <span class="time">12:16AM</span> <abbr class="timezone" title="UTC">UTC</abbr></span>
          </h4>
          <blockquote class="userstuff"><p>First comment.</p></blockquote>
          <ul class="actions">
            <li><a data-remote="true" href="/comments/add_comment_reply?chapter_id=193562681&amp;id=1038237076">Reply</a></li>
            <li><a href="/comments/1038237076">Thread</a></li>
          </ul>
        </li>
        <li class="even comment group user-19645747" id="comment_1038290406">
          <h4 class="heading byline">
            <a href="/users/KaitoHawk/pseuds/KaitoHawk">KaitoHawk</a>
            <span class="parent">on <a href="/works/51621847/chapters/193562681">Chapter 430</a></span>
            <span class="posted datetime"><abbr class="day" title="Saturday">Sat</abbr> <span class="date">15</span> <abbr class="month" title="November">Nov</abbr> <span class="year">2025</span> <span class="time">01:53AM</span> <abbr class="timezone" title="UTC">UTC</abbr></span>
          </h4>
          <blockquote class="userstuff"><p>A reply.</p></blockquote>
          <ul class="actions">
            <li><a data-remote="true" href="/comments/add_comment_reply?chapter_id=193562681&amp;id=1038290406">Reply</a></li>
            <li><a href="/comments/1038237076">Parent</a></li>
            <li><a href="/comments/1038237076">Parent Thread</a></li>
            <li><a href="/comments/1038290406">Thread</a></li>
          </ul>
        </li>
      </ol>
    </div>`;

  it("extracts comments and reconstructs the reply tree", () => {
    const comments = parseCommentsHtml(html, {
      sourceWorkId: "51621847",
      origin,
      creatorProfileUrls: ["https://archiveofourown.org/users/KaitoHawk/pseuds/KaitoHawk"],
    });

    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({
      sourceCommentId: "1038237076",
      parentSourceCommentId: null,
      authorName: "Silvigor",
      depth: 0,
      fromWorkCreator: false,
      textHtml: "<p>First comment.</p>",
    });
    expect(comments[1]).toMatchObject({
      sourceCommentId: "1038290406",
      parentSourceCommentId: "1038237076",
      authorName: "KaitoHawk",
      depth: 1,
      fromWorkCreator: true,
      textHtml: "<p>A reply.</p>",
    });
    expect(comments[0]!.postedAt).toBe("Sat 15 Nov 2025 12:16AM UTC");
    expect(comments[1]!.authorProfileUrl).toBe("https://archiveofourown.org/users/KaitoHawk/pseuds/KaitoHawk");
  });
});

describe("kudos parser", () => {
  it("extracts named kudos-givers", () => {
    const html = `<div id="kudos">
      <p class="kudos">
        <a href="/users/KingJJ1sk00l">KingJJ1sk00l</a>, <a href="/users/AvenleaCorwyn">AvenleaCorwyn</a>, and 13 guests left kudos on this work!
      </p>
    </div>`;
    const kudos = parseKudosHtml(html, { sourceWorkId: "51621847", origin, observedAt: "2026-08-20T09:00:00.000Z" });
    expect(kudos).toEqual([
      {
        sourceWorkId: "51621847",
        sourceKudoId: "user:KingJJ1sk00l",
        authorName: "KingJJ1sk00l",
        authorProfileUrl: "https://archiveofourown.org/users/KingJJ1sk00l",
        observedAt: "2026-08-20T09:00:00.000Z",
      },
      {
        sourceWorkId: "51621847",
        sourceKudoId: "user:AvenleaCorwyn",
        authorName: "AvenleaCorwyn",
        authorProfileUrl: "https://archiveofourown.org/users/AvenleaCorwyn",
        observedAt: "2026-08-20T09:00:00.000Z",
      },
    ]);
  });
});

describe("bookmark parser", () => {
  it("extracts public bookmarks with notes and tags", () => {
    const html = `
      <ol class="bookmark index group">
        <li class="user short blurb group user-21853189">
          <div class="header module">
            <h5 class="byline heading">Bookmarked by <a href="/users/Sundays_follower/pseuds/Sundays_follower">Sundays_follower</a></h5>
            <p class="datetime">01 Aug 2026</p>
          </div>
          <h6 class="meta heading">Bookmark Tags:</h6>
          <ul class="meta tags commas"><li><a class="tag" href="/tags/Intriguing%20enough/bookmarks">Intriguing enough</a></li></ul>
          <blockquote class="userstuff"><p>A lovely read.</p></blockquote>
        </li>
      </ol>`;
    const bookmarks = parseBookmarksHtml(html, { sourceWorkId: "51621847", origin });
    expect(bookmarks).toEqual([{
      operation: "upsert",
      sourceBookmarkId: "bookmark:51621847:Sundays_follower",
      sourceWorkId: "51621847",
      bookmarkerName: "Sundays_follower",
      bookmarkerProfileUrl: "https://archiveofourown.org/users/Sundays_follower/pseuds/Sundays_follower",
      notesHtml: "<p>A lovely read.</p>",
      tags: [{ name: "Intriguing enough" }],
      updatedAt: "01 Aug 2026",
      contentHash: expect.any(String),
    }]);
  });
});

describe("nextPageUrl", () => {
  it("returns the next page link", () => {
    const html = `<ol class="pagination actions"><li class="previous"><span>← Previous</span></li><li><a href="/works/1/kudos?page=1">1</a></li><li class="next"><a rel="next" href="/works/1/kudos?page=2">Next →</a></li></ol>`;
    expect(nextPageUrl(html, "https://archiveofourown.org/works/1/kudos")).toBe("https://archiveofourown.org/works/1/kudos?page=2");
  });

  it("returns null when there is no next page", () => {
    expect(nextPageUrl("<div class='pagination'><a href='/works/1/kudos?page=1'>1</a></div>", "https://archiveofourown.org/works/1/kudos")).toBeNull();
  });
});
