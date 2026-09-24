import * as React from "react";
import { cn } from "../../lib/cn";

const variants = {
  primary:
    "bg-signal text-white hover:bg-signal-deep active:bg-signal-deep shadow-[0_1px_0_rgba(255,255,255,0.12)_inset]",
  secondary:
    "bg-ink-raised text-ink-text border border-ink-line hover:border-ink-soft/60",
  ghost: "bg-transparent text-ink-soft hover:text-ink-text hover:bg-ink-raised",
  gold: "bg-gold text-ink hover:brightness-105",
  danger: "bg-signal-soft text-signal border border-signal/40 hover:bg-signal/15",
} as const;

const sizes = {
  default: "h-12 px-5 text-base",
  sm: "h-11 px-4 text-sm",
  lg: "h-14 px-6 text-lg",
  icon: "h-11 w-11",
} as const;

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "default", type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors",
        "disabled:pointer-events-none disabled:opacity-40",
        "select-none active:brightness-95",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
