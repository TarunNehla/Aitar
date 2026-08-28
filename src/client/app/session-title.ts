export const defaultSessionTitle = "New session";

const maxWords = 8;
const maxCharacters = 50;
const leadingMarkers = /^(?:[-*+]\s+|>\s+|#{1,6}\s+|\d+[.)]\s+)+/;

const leadIns = [
  "i want you to",
  "i want to",
  "i would like you to",
  "i would like to",
  "i need you to",
  "i need to",
  "can you please",
  "could you please",
  "would you please",
  "please can you",
  "can you",
  "could you",
  "would you",
  "help me to",
  "help me",
  "let's",
  "lets",
  "please",
].sort((left, right) => right.length - left.length);

/** A truncated title should not trail off on a joining word. */
const connectors = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in",
  "of", "on", "or", "so", "that", "the", "to", "with",
]);

function firstSentence(text: string): string {
  const match = /^.*?[.!?](?=\s|$)/.exec(text);
  if (!match) return text;
  const sentence = match[0].replace(/[.!?]+$/, "").trim();
  return sentence.split(" ").length < 2 ? text.replace(/[.!?]+$/, "").trim() : sentence;
}

function stripLeadIn(text: string): string {
  let value = text;
  for (let round = 0; round < 2; round += 1) {
    const lowered = value.toLowerCase();
    const leadIn = leadIns.find((phrase) => lowered.startsWith(`${phrase} `));
    if (!leadIn) return value;
    value = value.slice(leadIn.length + 1).trim();
  }
  return value;
}

function shorten(phrase: string): string {
  const words = phrase.split(" ");
  const kept = words.slice(0, maxWords);
  while (kept.length > 1 && kept.join(" ").length > maxCharacters) kept.pop();

  if (kept.length === words.length) {
    const title = kept.join(" ");
    return title.length > maxCharacters ? `${title.slice(0, maxCharacters - 1)}…` : title;
  }

  while (kept.length > 1 && connectors.has(kept[kept.length - 1].toLowerCase())) kept.pop();
  return `${kept.join(" ").replace(/[,;:]+$/, "")}…`;
}

export function deriveSessionTitle(message: string): string {
  const line = message
    .split("\n")
    .map((entry) => entry.replace(/\s+/g, " ").trim().replace(leadingMarkers, "").trim())
    .find(Boolean);
  if (!line) return defaultSessionTitle;

  const phrase = stripLeadIn(firstSentence(line));
  if (!phrase) return defaultSessionTitle;

  const capitalised = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  return shorten(capitalised);
}
