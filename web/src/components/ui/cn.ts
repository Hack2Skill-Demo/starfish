import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Join class names; later Tailwind utilities win over earlier conflicting ones. */
export const cn = (...parts: ClassValue[]): string => twMerge(clsx(parts));
