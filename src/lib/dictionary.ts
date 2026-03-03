export interface DictionaryEntry {
  id: string;
  reading: string;
  notation: string;
}

const STORAGE_KEY = "videoscribe-dictionary";

export function loadDictionary(): DictionaryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

export function saveDictionary(entries: DictionaryEntry[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function applyDictionary(
  text: string,
  entries: DictionaryEntry[],
): string {
  let result = text;
  for (const entry of entries) {
    if (entry.reading && entry.notation && entry.reading !== entry.notation) {
      result = result.replaceAll(entry.reading, entry.notation);
    }
  }
  return result;
}

export function buildWhisperPrompt(entries: DictionaryEntry[]): string {
  if (entries.length === 0) return "";
  return entries.map((e) => e.notation).join("、");
}
