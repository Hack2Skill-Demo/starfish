import { Link } from "react-router";
import PageMeta from "../components/PageMeta";

export default function NotFound() {
  return (
    <>
      <PageMeta title="Not Found | Starfish" description="Page not found" />
      <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <p className="font-display text-6xl font-bold text-gray-300 dark:text-gray-700">404</p>
        <h1 className="mt-4 text-xl font-semibold text-gray-900 dark:text-white">Page not found</h1>
        <Link to="/incidents" className="mt-6 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
          Back to incidents
        </Link>
      </div>
    </>
  );
}
