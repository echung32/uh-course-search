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

export interface MultiComboboxOption {
  value: string;
  label: string;
  keywords?: string;
}

interface MultiComboboxProps {
  options: MultiComboboxOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

export function MultiCombobox({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No match.",
  id,
  disabled,
  className,
}: MultiComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  // The selection snapshot taken when the menu opens. Items selected at open
  // time float to the top, so reopening surfaces your current picks first. It's
  // frozen at open (not live `value`) so toggling while open doesn't make rows
  // jump around under the cursor.
  const [pinned, setPinned] = React.useState<Set<string>>(new Set());
  const selectedSet = new Set(value);

  const q = query.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    const matches =
      q === ""
        ? options
        : options.filter((o) =>
            `${o.label} ${o.value} ${o.keywords ?? ""}`.toLowerCase().includes(q)
          );
    // Stable partition: pinned (selected-at-open) first, original order otherwise.
    return [
      ...matches.filter((o) => pinned.has(o.value)),
      ...matches.filter((o) => !pinned.has(o.value)),
    ];
  }, [options, q, pinned]);

  const triggerLabel =
    value.length === 0 ? placeholder : `${value.length} selected`;

  function toggle(v: string) {
    onChange(selectedSet.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Snapshot the current selection on open so it sorts to the top; clear the
    // search box on close so it reopens clean.
    if (next) setPinned(new Set(value));
    else setQuery("");
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
            value.length === 0 && "text-muted-foreground",
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
            {filtered.length === 0 && <CommandEmpty>{emptyText}</CommandEmpty>}
            <CommandGroup>
              {filtered.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  onSelect={() => toggle(o.value)}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      selectedSet.has(o.value) ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {o.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
