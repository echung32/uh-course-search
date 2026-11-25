# Analytics page: two control groups + waitlist removal

Small change. Approved 2026-11-25.

## Intent

The analytics page mixes page-wide filters with per-chart filters and never says
which is which. The top bar (term range, semesters, special sessions) silently
drives four charts, while Course demand and When classes meet each carry their own
term + campus pickers, so a reader picks the same term twice and can't tell what a
control affects. Separately, reviewer feedback showed the waitlist numbers mislead:
Banner's per-section `wait_count` is summed, but students join waitlists in many
sections at once (Spring 2027 LING 102 at Mānoa: 11 sections each 30/30 waitlisted,
four of them 0-capacity placeholders → we show ~331; the true headcount is somewhere
in 30..331 and isn't knowable from public data).

## Goals

- Group charts by what controls them, with the group's filter bar visibly at the top
  of the group, labelled as applying to every chart in it.
- One term + campus selection drives both single-term charts.
- Chart-specific controls are visibly marked as local ("This chart").
- Stop presenting waitlist totals anywhere on the analytics page.

## Non-goals / anti-goals

- No page-wide campus filter for the trend charts (university/delivery/subject
  rollups have no campus dimension; would need a rollup change).
- No rollup or migration change — `total_wait` stays in the analytics DB.
- Don't couple the single-term charts to the range's end term (moving the range
  must not silently change the leaderboard).

## Approaches considered

1. **Two labelled groups (picked).** "Trends over time" under the range/semester
   bar; "One term" under a shared term + campus bar. Local controls only for
   chart-specific choices.
2. One bar; single-term charts use the range's end term. Fewer controls, but
   surprising coupling.
3. Keep layout, add "uses page filters / own filters" badges. Cheapest, but the
   term is still picked twice.

## Design

- **Trends over time** group: header + existing range/semester/special controls,
  subtitle "These filters apply to all 4 charts in this group". Charts: Course
  enrollment over time (local: course, campus), University enrollment trend (local:
  campus/college toggle), Delivery-mode shift, Subject growth.
- **One term** group: header + Term and Campus comboboxes, subtitle "These filters
  apply to both charts in this group". Charts: Course demand (fill rate only), When
  classes meet. No local controls.
- Local controls sit in a dashed box labelled "This chart".
- Each chart stays full width, one per row, as today.
- One-term term + campus are URL state (nuqs, like the range). With no `term` in
  the URL the group uses the newest rollup term (from the page's `rollupTerms`
  prop — the same list the API defaults from); it's shown in the picker but only
  written to the URL once the user picks a term.
- Waitlist removed: Course demand's Waitlist sort + tooltip row; the waitlist line
  on Course enrollment over time.

## Calls made by the builder (Claude)

- Also remove the `sort=waitlist` mode from `/api/analytics/fill-rate` and
  `getFillRateLeaderboard` (no remaining caller), with its e2e tests; the
  `waitlist` field stays in API responses.
- Keep existing control labels ("Term range", "Last 3 yrs" …) rather than the
  mockup's shorter ones.
- URL params for the one-term group: `term`, `campus`.
