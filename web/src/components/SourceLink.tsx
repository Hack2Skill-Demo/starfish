import { webConfig } from "../lib/config";
import { GithubMark } from "./GithubMark";

/** A GitHub mark linking to the source repository, only when the build sets `VITE_STARFISH_SOURCE_URL` (the public demo). */
export function SourceLink({ className = "" }: { className?: string }) {
  const url = webConfig().sourceUrl;
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex items-center gap-1.5 font-medium text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white ${className}`}
    >
      <GithubMark />
      Source on GitHub
    </a>
  );
}
