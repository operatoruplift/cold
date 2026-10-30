/**
 * Clean up after substitution: trailing spaces, doubled spaces, a space left
 * before punctuation by an empty value ("Hi ," -> "Hi,"), and runs of blank
 * lines. Leading indentation is kept.
 */
export function tidyText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/(\S) {2,}/g, "$1 ")
    .replace(/ +([,.!?;:])(?=\s|$)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
