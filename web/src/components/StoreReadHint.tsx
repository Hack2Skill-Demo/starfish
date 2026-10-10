/**
 * What to check when a read of the store fails, said the same way on every page that reads it (#262). Firestore refuses
 * a query the live rules do not allow (rules older than this UI: the web deploy publishes the UI only, the engine deploy
 * the rules and indexes) and a query whose composite index is missing or still building, which takes minutes after an
 * index is deployed. A sentence, to follow the page's own "Couldn't read …".
 */
export default function StoreReadHint() {
  return (
    <>
      Check that firestore.rules and firestore.indexes.json are deployed to the Starfish database. An index deployed in
      the last few minutes may still be building; until it is, the reads it serves fail.
    </>
  );
}
