"use client";

import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Extra text folded into the search filter (e.g. a subject's full name). */
  keywords?: string;
  /** Rendered greyed-out and unselectable (e.g. a campus with no data). */
  disabled?: boolean;
}

/**
 * Cap on rendered rows. The course picker holds ~15k options; mounting them all
 * makes opening/typing janky (cmdk filters by hiding DOM nodes). We filter
 * ourselves and render only the first N matches, nudging the user to narrow via
 * search instead. Campus/term pickers are far smaller than this and unaffected.
 */
const MAX_VISIBLE = 50;

interface ComboboxProps {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  /** Trigger text when nothing is selected. */
  placeholder?: string;
  /** Search box placeholder. */
  searchPlaceholder?: string;
  /** Shown when the filter matches nothing. */
  emptyText?: string;
  /**
   * When set, a leading "clear" entry resetting to "" is shown with this label
   * (used by optional facets: All Subjects / All Colleges / …).
   */
  clearLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No match.",
  clearLabel,
  id,
  disabled,
  className,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const selected = options.find((o) => o.value === value);
  const triggerLabel = selected
    ? selected.label
    : clearLabel && value === ""
      ? clearLabel
      : placeholder;

  // Self-filter (cmdk's built-in filter is disabled below) and cap the rendered
  // rows so a huge option list stays responsive.
  const q = query.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    if (q === "") return options;
    return options.filter((o) =>
      `${o.label} ${o.value} ${o.keywords ?? ""}`.toLowerCase().includes(q)
    );
  }, [options, q]);
  const visible = filtered.slice(0, MAX_VISIBLE);
  const hiddenCount = filtered.length - visible.length;
  const showClear =
    clearLabel !== undefined && (q === "" || clearLabel.toLowerCase().includes(q));

  function pick(next: string) {
    onChange(next);
    setOpen(false);
  }

  // Reset the search box each time the popover closes so it reopens clean.
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "w-full justify-between font-normal",
            !selected && "text-muted-foreground",
            className
          )}
        >
          <span className="line-clamp-1 text-left">{triggerLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {visible.length === 0 && !showClear && (
              <CommandEmpty>{emptyText}</CommandEmpty>
            )}
            <CommandGroup>
              {showClear && (
                <CommandItem value="__clear__" onSelect={() => pick("")}>
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === "" ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {clearLabel}
                </CommandItem>
              )}
              {visible.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  disabled={o.disabled}
                  onSelect={() => pick(o.value)}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === o.value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {o.label}
                </CommandItem>
              ))}
            </CommandGroup>
            {hiddenCount > 0 && (
              <p className="px-3 py-2 text-center text-xs text-muted-foreground">
                +{hiddenCount} more — keep typing to narrow
              </p>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
