/**
 * Page title/description. Starfish's own version of the shared PageMeta: the
 * shared one wraps react-helmet-async, while React 19 hoists <title> and <meta>
 * into <head> natively, so no dependency is needed for the same result.
 */
export default function PageMeta({ title, description }: { title: string; description: string }) {
  return (
    <>
      <title>{title}</title>
      <meta name="description" content={description} />
    </>
  );
}
