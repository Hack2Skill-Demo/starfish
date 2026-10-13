import { useId } from "react";

/** Gemini's four-pointed sparkle in its blue-to-violet gradient. Decorative: the step says what the model did. */
export function GeminiMark({ className = "h-4 w-4" }: { className?: string }) {
  const fill = useId();
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <defs>
        <linearGradient id={fill} x1="0" y1="24" x2="24" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4285F4" />
          <stop offset="0.55" stopColor="#9B72CB" />
          <stop offset="1" stopColor="#D96570" />
        </linearGradient>
      </defs>
      <path fill={`url(#${fill})`} d="M12 0C12 6.627 17.373 12 24 12C17.373 12 12 17.373 12 24C12 17.373 6.627 12 0 12C6.627 12 12 6.627 12 0Z" />
    </svg>
  );
}
