import type { ReactNode } from "react";

/** Something drawn at an icon's size: a lucide icon, or one of the platform marks below. */
export type IconLike = (props: { size?: number; className?: string }) => ReactNode;

/** A small letter mark for a platform (lucide no longer ships brand icons). */
function mark(letters: string, title: string): IconLike {
  return function Mark({ size = 14, className }) {
    return (
      <span
        className={className}
        title={title}
        aria-hidden="true"
        style={{ display: "inline-grid", placeItems: "center", width: size, height: size, borderRadius: 3, border: "1.5px solid currentColor", fontSize: Math.max(7, size * 0.48), fontWeight: 700, lineHeight: 1, letterSpacing: "-0.02em", flex: "none" }}
      >
        {letters}
      </span>
    );
  };
}

export const LinkedinMark = mark("in", "LinkedIn");
export const XMark = mark("X", "X");
export const InstagramMark = mark("IG", "Instagram");
export const FacebookMark = mark("f", "Facebook");
