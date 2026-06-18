"use client";

import * as React from "react";

/**
 * Theme-aware Recharts tooltip. The built-in <Tooltip> renders a hard-coded
 * white card, so in dark mode the (also-themed) text is white-on-white and
 * invisible. Rendering our own card with `bg-popover`/`text-popover-foreground`
 * tracks the active theme. Pass it via <Tooltip content={<ChartTooltip … />} />;
 * Recharts injects `active`/`payload`/`label` onto the cloned element.
 */
interface TooltipPayloadItem {
  name?: string | number;
  value?: number | string;
  color?: string;
}

export function ChartTooltip({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string | number;
  /** Formats the header (e.g. a term code → "Fall 2025"). */
  labelFormatter?: (label: string) => string;
  /** Formats each row's value (e.g. n → "42.0%"). */
  valueFormatter?: (value: number, name: string) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const header = labelFormatter ? labelFormatter(String(label)) : String(label);
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium text-popover-foreground">{header}</div>
      <ul className="space-y-0.5">
        {payload.map((p, i) => {
          const name = String(p.name ?? "");
          const value = valueFormatter
            ? valueFormatter(Number(p.value), name)
            : String(p.value);
          return (
            <li key={i} className="flex items-center gap-2 text-popover-foreground">
              <span
                aria-hidden="true"
                className="inline-block size-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: p.color }}
              />
              <span className="text-muted-foreground">{name}</span>
              <span className="ml-auto pl-3 font-medium tabular-nums">{value}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
