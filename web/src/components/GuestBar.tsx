/**
 * The bar under every page for a guest (an anonymous session on the public demo, #12). It says the view is read-only
 * (or, where the public demo's open actions are on, what a visitor can do and that it is limited per IP address to
 * protect billing), reopens the welcome guide, and offers sign-in. A guest who did not choose the view-only demo is also told
 * where the sign-in details are (`signInHint`); one who chose it just gets the link.
 */
import { Link, useLocation } from "react-router";
import { signInHint, visitorActions } from "../lib/demoGuide";
import { SourceLink } from "./SourceLink";
import { publicDemoActionsOn, signInPath } from "../lib/dataSource";

export function GuestBar({ askToSignIn, onOpenGuide }: { askToSignIn: boolean; onOpenGuide?: () => void }) {
  const location = useLocation();
  // Where the public demo's open actions are on, the bar says what a visitor can do and that it is limited per address.
  const open = visitorActions();
  return (
    <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-gray-200 bg-white px-4 py-2 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 lg:px-6">
      <span>
        {open ? `Public demo · ${open.short}` : "Public demo · view only"}
        {askToSignIn && !publicDemoActionsOn() && (
          <>
            {" "}
            · <span className="text-gray-800 dark:text-gray-200">Sign in for the full records. {signInHint()}</span>
          </>
        )}
      </span>
      <span className="flex items-center gap-4">
        <SourceLink />
        {onOpenGuide && (
          <button
            type="button"
            onClick={onOpenGuide}
            className="font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            What is Starfish?
          </button>
        )}
        {!publicDemoActionsOn() && <Link
          to={signInPath()}
          state={{ from: location }}
          className="font-medium text-brand-700 hover:underline dark:text-brand-400"
        >
          Sign in
        </Link>}
      </span>
    </footer>
  );
}
