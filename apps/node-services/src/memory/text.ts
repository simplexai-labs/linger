/** The bound a memory page title is stored with, in code points. */
export const MAX_TITLE_CODE_POINTS = 512;

/**
 * Cuts a title to the longest prefix within the stored bound, so a heading that
 * ends inside an astral character keeps both of its halves: a lone surrogate
 * would be stored, served to an Agent and rendered as a broken glyph.
 */
export function truncateTitle(title: string): string {
  const characters = [...title];
  return characters.length <= MAX_TITLE_CODE_POINTS
    ? title
    : characters.slice(0, MAX_TITLE_CODE_POINTS).join("");
}
