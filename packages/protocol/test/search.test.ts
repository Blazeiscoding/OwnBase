import { describe, expect, it } from "vitest";
import {
  cachedTimeZones,
  currentZoneName,
  fileKind,
  hasSearchCriteria,
  isTimeZone,
  parseSearchQuery,
} from "../src/search.js";

describe("parseSearchQuery", () => {
  it("keeps plain words as search terms", () => {
    const p = parseSearchQuery("quarterly zebra report");
    expect(p.terms).toEqual(["quarterly", "zebra", "report"]);
    expect(p.from).toEqual([]);
  });

  it("pulls out modifiers and leaves the rest as terms", () => {
    const p = parseSearchQuery("from:@alice in:#general has:link deploy notes");
    expect(p.from).toEqual(["alice"]);
    expect(p.in).toEqual(["general"]);
    expect(p.has).toEqual(["link"]);
    expect(p.terms).toEqual(["deploy", "notes"]);
  });

  it("accepts modifiers with or without the @ and # sigils", () => {
    expect(parseSearchQuery("from:alice in:general").from).toEqual(["alice"]);
    expect(parseSearchQuery("from:alice in:general").in).toEqual(["general"]);
  });

  it("is case-insensitive on the modifier name and value", () => {
    const p = parseSearchQuery("FROM:@Alice IN:#General");
    expect(p.from).toEqual(["alice"]);
    expect(p.in).toEqual(["general"]);
  });

  it("treats after: as exclusive of the named day and before: as up to it", () => {
    const p = parseSearchQuery("after:2026-01-01 before:2026-02-01");
    expect(new Date(p.after!).getDate()).toBe(2);
    expect(new Date(p.before!).getDate()).toBe(1);
    expect(new Date(p.before!).getMonth()).toBe(1);
  });

  it("ignores unknown has: values, and names a date it cannot read rather than dropping it", () => {
    const p = parseSearchQuery("before:yesterday has:banana");
    expect(p.before).toBeNull();
    expect(p.has).toEqual([]);
    expect(p.invalid).toEqual(["before:yesterday"]);
    // Neither becomes a free-text term — they were still modifier syntax.
    expect(p.terms).toEqual([]);
  });

  it("treats an empty modifier value as noise", () => {
    expect(parseSearchQuery("from:").from).toEqual([]);
    expect(hasSearchCriteria(parseSearchQuery("from:"))).toBe(false);
  });

  it("accepts several of the same modifier", () => {
    const p = parseSearchQuery("from:@alice from:@bob");
    expect(p.from).toEqual(["alice", "bob"]);
  });

  it("reports whether there is anything to search for", () => {
    expect(hasSearchCriteria(parseSearchQuery(""))).toBe(false);
    expect(hasSearchCriteria(parseSearchQuery("   "))).toBe(false);
    expect(hasSearchCriteria(parseSearchQuery("in:#general"))).toBe(true);
    expect(hasSearchCriteria(parseSearchQuery("hello"))).toBe(true);
    expect(hasSearchCriteria(parseSearchQuery("type:pdf"))).toBe(true);
  });

  it("reads the kinds of file asked for once each, and leaves out kinds there are not (IMP-02)", () => {
    const p = parseSearchQuery("TYPE:PDF type:image type:pdf type:banana budget");
    expect(p.types).toEqual(["pdf", "image"]);
    expect(p.terms).toEqual(["budget"]);
    expect(hasSearchCriteria(parseSearchQuery("type:banana"))).toBe(false);
  });
});

describe("dates in a search", () => {
  const inZone = (query: string, timeZone: string) => parseSearchQuery(query, { timeZone });

  it("starts the day after a spring-forward day where that day starts, not 24 hours on", () => {
    // New York moves to daylight time on 8 March 2026; the 9th starts at 04:00 UTC.
    const p = inZone("after:2026-03-08 before:2026-03-08", "America/New_York");
    expect(p.after).toBe(Date.UTC(2026, 2, 9, 4));
    expect(p.before).toBe(Date.UTC(2026, 2, 8, 5));
  });

  it("does not let a fall-back day's extra hour leak into the next", () => {
    // 1 November 2026 has 25 hours in New York; the 2nd starts at 05:00 UTC.
    const p = inZone("after:2026-11-01 before:2026-11-01", "America/New_York");
    expect(p.after).toBe(Date.UTC(2026, 10, 2, 5));
    expect(p.before).toBe(Date.UTC(2026, 10, 1, 4));
  });

  it("starts a day that has no midnight at its first real instant", () => {
    // Havana and Santiago move their clocks forward at midnight.
    expect(inZone("before:2026-03-08", "America/Havana").before).toBe(Date.UTC(2026, 2, 8, 5));
    expect(inZone("before:2026-09-06", "America/Santiago").before).toBe(Date.UTC(2026, 8, 6, 4));
  });

  it("names the reader's days across the whole range of offsets", () => {
    expect(inZone("before:2026-01-15", "Asia/Kolkata").before).toBe(Date.UTC(2026, 0, 14, 18, 30));
    expect(inZone("before:2026-01-15", "Pacific/Kiritimati").before).toBe(
      Date.UTC(2026, 0, 14, 10),
    );
    expect(inZone("before:2026-01-15", "Pacific/Pago_Pago").before).toBe(Date.UTC(2026, 0, 15, 11));
    expect(inZone("before:2026-01-15", "UTC").before).toBe(Date.UTC(2026, 0, 15));
  });

  it("gives the same bounds whatever zone the process itself runs in", () => {
    const original = process.env.TZ;
    try {
      const bounds = ["Asia/Tokyo", "America/Los_Angeles", "UTC"].map((zone) => {
        process.env.TZ = zone;
        const p = inZone("after:2026-03-08 before:2026-11-01", "America/New_York");
        return [p.after, p.before];
      });
      expect(new Set(bounds.map((b) => b.join()))).toHaveProperty("size", 1);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("accepts a leap day only in a leap year, and refuses days that do not exist", () => {
    expect(inZone("after:2028-02-29", "UTC").after).toBe(Date.UTC(2028, 2, 1));
    const p = inZone(
      "after:2026-02-29 before:2026-02-31 after:2026-13-01 before:2026-00-10 after:0099-01-01",
      "UTC",
    );
    expect(p.after).toBeNull();
    expect(p.before).toBeNull();
    expect(p.invalid).toEqual([
      "after:2026-02-29",
      "before:2026-02-31",
      "after:2026-13-01",
      "before:2026-00-10",
      "after:0099-01-01",
    ]);
  });

  it("says back the days as they were named", () => {
    const p = inZone("after:2026-01-31 before:2026-03-01", "Asia/Kolkata");
    expect([p.afterDay, p.beforeDay]).toEqual(["2026-01-31", "2026-03-01"]);
  });

  it("knows a time zone from a made-up one", () => {
    expect(isTimeZone("Europe/Paris")).toBe(true);
    expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
  });

  it("gives a zone the name it has now, where a runtime still gives an old one", () => {
    expect(currentZoneName("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(currentZoneName("Europe/Kiev")).toBe("Europe/Kyiv");
    expect(currentZoneName("Europe/Paris")).toBe("Europe/Paris");
    // Every zone this runtime lists, under its current name, is one it knows,
    // and reads the same clock as under the name it gave.
    const at = Date.UTC(2026, 6, 1, 12, 34);
    const clock = (zone: string) =>
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeStyle: "short" }).format(at);
    for (const zone of Intl.supportedValuesOf("timeZone")) {
      expect(isTimeZone(currentZoneName(zone)), zone).toBe(true);
      expect(clock(currentZoneName(zone)), zone).toBe(clock(zone));
    }
  });
});

describe("the time zones kept for dates", () => {
  // Any signed-in member chooses the zone a search is read in, so what is kept
  // for zones has to be bounded by this process, not by what they send.
  const name = "America/Argentina/Buenos_Aires";

  it("keeps one formatter for a zone however its name is capitalised", () => {
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions()
      .timeZone;
    for (let mask = 0; mask < 512; mask++) {
      let bit = 0;
      const spelling = [...name]
        .map((c) =>
          /[A-Za-z]/.test(c) && bit < 9
            ? (mask >> bit++) & 1
              ? c.toUpperCase()
              : c.toLowerCase()
            : c,
        )
        .join("");
      expect(isTimeZone(spelling)).toBe(true);
      // Buenos Aires keeps UTC-3 all year.
      expect(parseSearchQuery("before:2026-11-01", { timeZone: spelling }).before).toBe(
        Date.UTC(2026, 10, 1, 3),
      );
    }
    expect(cachedTimeZones().filter((zone) => /buenos_aires/i.test(zone))).toEqual([canonical]);
  });

  it("holds a bounded number of zones however many different ones are asked for", () => {
    const zones = Intl.supportedValuesOf("timeZone");
    expect(zones.length).toBeGreaterThan(32);
    for (const zone of zones) expect(isTimeZone(zone)).toBe(true);
    expect(cachedTimeZones().length).toBeLessThanOrEqual(32);
    // A zone pushed out is made again when asked for, with the same answers.
    const p = parseSearchQuery("after:2026-03-08 before:2026-11-01", {
      timeZone: "america/new_york",
    });
    expect([p.after, p.before]).toEqual([Date.UTC(2026, 2, 9, 4), Date.UTC(2026, 10, 1, 4)]);
  });

  it("keeps nothing for a zone it does not know", () => {
    const before = cachedTimeZones();
    for (let i = 0; i < 100; i++) expect(isTimeZone(`Mars/Crater_${i}`)).toBe(false);
    expect(cachedTimeZones()).toEqual(before);
  });
});

describe("fileKind", () => {
  it("sorts files as the file browser's filter does (E7)", () => {
    expect(fileKind("image/png", "shot.png")).toBe("image");
    // A picture is a picture, whatever its name ends with.
    expect(fileKind("IMAGE/PNG", "scan.pdf")).toBe("image");
    expect(fileKind("application/pdf", "brief")).toBe("document");
    expect(fileKind("text/plain", "notes.txt")).toBe("document");
    // Sent as anything at all, a file is known by its name's ending.
    expect(fileKind("application/octet-stream", "Budget.XLSX")).toBe("document");
    expect(fileKind("", "deck.pptx")).toBe("document");
    expect(
      fileKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a"),
    ).toBe("document");
    expect(fileKind("video/mp4", "clip.mp4")).toBe("other");
    expect(fileKind("application/zip", "archive.zip")).toBe("other");
    expect(fileKind("text/html", "page.html")).toBe("other");
  });
});
