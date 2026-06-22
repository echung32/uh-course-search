import { test, expect } from "@playwright/test";
import { sectionStatus } from "../src/lib/sectionStatus";

// Pure-function test: the status rail's three buckets are derived from a
// section's open flag + seat/waitlist counts (see ResultsTable's left rail).
type Seats = {
  openSection: boolean;
  seatsAvailable: number;
  waitAvailable: number;
};
const s = (o: boolean, seats: number, wait: number): Seats => ({
  openSection: o,
  seatsAvailable: seats,
  waitAvailable: wait,
});

test("open with seats available is 'open' (enter immediately)", () => {
  expect(sectionStatus(s(true, 5, 0))).toBe("open");
  expect(sectionStatus(s(true, 1, 3))).toBe("open"); // seats win over waitlist
});

test("open but full with waitlist room is 'waitlist'", () => {
  expect(sectionStatus(s(true, 0, 6))).toBe("waitlist");
  expect(sectionStatus(s(true, -1, 2))).toBe("waitlist"); // negative seats = full
});

test("open but full with no waitlist room is 'closed'", () => {
  expect(sectionStatus(s(true, 0, 0))).toBe("closed");
});

test("not open is always 'closed', regardless of seats/waitlist", () => {
  expect(sectionStatus(s(false, 10, 5))).toBe("closed");
  expect(sectionStatus(s(false, 0, 0))).toBe("closed");
});
