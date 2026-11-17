/**
 * Whether a node `matches` is put on screen from now until the returned call, however
 * briefly: a cached page painted and then replaced still counts. Each added subtree is
 * tested once, at its root.
 */
export function watchFor(matches: (added: Node) => boolean) {
  let seen = false;
  const look = (records: MutationRecord[]) => {
    for (const { addedNodes } of records) {
      for (const node of addedNodes) if (matches(node)) seen = true;
    }
  };
  const observer = new MutationObserver(look);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    // disconnect drops records not yet delivered
    look(observer.takeRecords());
    observer.disconnect();
    return seen;
  };
}

/** An added subtree holding an element that matches `selector`. */
export const holding = (selector: string) => (added: Node) =>
  added instanceof Element &&
  (added.matches(selector) || added.querySelector(selector) !== null);

/** An added subtree whose text includes `text`. */
export const reading = (text: string) => (added: Node) =>
  added.textContent?.includes(text) ?? false;
