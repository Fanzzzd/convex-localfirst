import { clsx, type ClassValue } from "clsx";

// clsx only: this app controls its own class strings, so there are no
// conflicting Tailwind utilities to resolve — tailwind-merge would be dead weight.
// ponytail: add tailwind-merge if we ever compose classes from untrusted props.
export const cn = (...inputs: ClassValue[]) => clsx(inputs);
