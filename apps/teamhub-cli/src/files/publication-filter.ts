/** Private runtime state and installed dependencies never belong in published folders. */
export const isExcludedPublicationEntry = (name: string): boolean => {
  // Windows and the default macOS filesystem resolve `.Git` to `.git`; a
  // platform check would leave that spelling publishable on a Mac, so these
  // names are private in any letter case.
  const entry = name.toLowerCase();
  return (
    [".teamhub", ".agents", ".git", "node_modules"].includes(entry) ||
    entry === ".env" ||
    entry.startsWith(".env.")
  );
};
