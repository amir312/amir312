import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Native select, styled. Chosen over a portal-based listbox on purpose:
 * it is fully RTL-correct, keyboard-accessible and mobile-native for free.
 */
function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "flex h-9 w-full appearance-none rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23777%22 stroke-width=%222%22><path d=%22m6 9 6 6 6-6%22/></svg>')] bg-no-repeat bg-[left_0.6rem_center] pl-8",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export { Select };
