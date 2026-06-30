import type { SelectHTMLAttributes } from "react";

/** The one `<select>` in the app. Wraps a native select with the shared box styling and a custom
 *  caret (the native arrow can't be inset consistently across platforms), so every dropdown looks the
 *  same — date/source filters, the Sessions sort, settings, anywhere. Add new variants here rather
 *  than re-styling a select inline, so the treatments can't drift apart.
 *
 *  Forwards every native `<select>` prop (value/onChange/aria-label/…). `wrapperClassName` lets a
 *  caller size the control for its context (e.g. a fixed width) without touching the look. */
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** "default" = a form-input box; "pill" = compact rounded, to sit among filter pills. */
  variant?: "default" | "pill";
  /** Extra class on the wrapper, for layout/sizing only (e.g. width). */
  wrapperClassName?: string;
}

export function Select({ variant = "default", wrapperClassName, className, children, ...rest }: SelectProps) {
  const wrap = `select${variant === "pill" ? " select--pill" : ""}${wrapperClassName ? ` ${wrapperClassName}` : ""}`;
  return (
    <span className={wrap}>
      <select className={`select__control${className ? ` ${className}` : ""}`} {...rest}>
        {children}
      </select>
    </span>
  );
}
