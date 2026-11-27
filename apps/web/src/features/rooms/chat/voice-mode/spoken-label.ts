/**
 * A control's name as the voice interface reads it aloud: whitespace collapsed,
 * then cut to `max` code points so a name never ends in half a character.
 */
export function spokenLabel(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const characters = [...cleaned];
  return characters.length <= max ? cleaned : characters.slice(0, max).join("");
}
