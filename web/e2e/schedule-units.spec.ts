// Node-only unit tests for the results table's Schedule column: the meeting
// formatters (src/lib/meetingTime.ts) and the per-term usual date range
// (src/lib/db/usualDates.ts). No browser, no app server.
import { test, expect } from "@playwright/test";
import {
  formatDateRange,
  formatMeetingLocation,
  formatTimeRange,
  shouldShowMeetingDates,
} from "../src/lib/meetingTime";
import type { MeetingTime } from "../src/lib/sis/types";

function mt(overrides: Partial<MeetingTime> = {}): MeetingTime {
  return {
    beginTime: null,
    endTime: null,
    startDate: null,
    endDate: null,
    building: null,
    buildingDescription: null,
    campus: null,
    campusDescription: null,
    room: null,
    creditHourSession: null,
    hoursWeek: null,
    meetingScheduleType: null,
    meetingType: null,
    meetingTypeDescription: null,
    monday: false,
    tuesday: false,
    wednesday: false,
    thursday: false,
    friday: false,
    saturday: false,
    sunday: false,
    ...overrides,
  };
}

test("formatTimeRange shares the meridiem", () => {
  expect(formatTimeRange("0900", "1015")).toBe("9:00–10:15 AM");
  expect(formatTimeRange("1600", "1945")).toBe("4:00–7:45 PM");
  expect(formatTimeRange("1130", "1245")).toBe("11:30 AM–12:45 PM");
  expect(formatTimeRange("0900", null)).toBe("9:00 AM–—");
  expect(formatTimeRange(null, null)).toBeNull();
});

test("formatMeetingLocation labels online rooms", () => {
  expect(formatMeetingLocation(mt({ building: "ONLINE", room: "ASYNC" }))).toBe("Online Async");
  expect(formatMeetingLocation(mt({ building: "ONLINE", room: "SYNC" }))).toBe("Online Sync");
  expect(formatMeetingLocation(mt({ building: "ONLINE", room: "TBA" }))).toBe("Online TBA");
  expect(formatMeetingLocation(mt({ building: "ONLINE", room: "WWW" }))).toBe("Online WWW");
  expect(formatMeetingLocation(mt({ building: "ONLINE", room: null }))).toBe("Online");
  expect(formatMeetingLocation(mt({ building: "LCCW", room: "ONLINE" }))).toBe("LCCW ONLINE");
  expect(formatMeetingLocation(mt({ building: "POST", room: "318A" }))).toBe("POST 318A");
  expect(formatMeetingLocation(mt({ building: null, room: null }))).toBe("—");
});

test("formatDateRange", () => {
  expect(formatDateRange("07/06/2026", "08/14/2026")).toBe("Jul 6 – Aug 14");
  expect(formatDateRange("07/06/2026", "07/06/2026")).toBe("Jul 6 – Jul 6");
});

test("shouldShowMeetingDates", () => {
  const usual = { start: "01/11/2027", end: "05/14/2027" };
  expect(shouldShowMeetingDates(mt({ startDate: "01/11/2027", endDate: "05/14/2027" }), usual)).toBe(false);
  expect(shouldShowMeetingDates(mt({ startDate: "01/11/2027", endDate: "03/05/2027" }), usual)).toBe(true);
  expect(shouldShowMeetingDates(mt({ startDate: "01/11/2027", endDate: "05/14/2027" }), null)).toBe(true);
  expect(shouldShowMeetingDates(mt({ startDate: "01/11/2027", endDate: "05/14/2027" }), undefined)).toBe(true);
  expect(shouldShowMeetingDates(mt({ startDate: null, endDate: "05/14/2027" }), null)).toBe(false);
});
