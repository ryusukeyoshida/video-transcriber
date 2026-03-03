"use client";

import { useState, useRef } from "react";
import type { DictionaryEntry } from "@/lib/dictionary";

interface Props {
  entries: DictionaryEntry[];
  onChange: (entries: DictionaryEntry[]) => void;
}

export function DictionaryManager({ entries, onChange }: Props) {
  const [reading, setReading] = useState("");
  const [notation, setNotation] = useState("");
  const importRef = useRef<HTMLInputElement>(null);

  const addEntry = () => {
    if (!reading.trim() || !notation.trim()) return;
    onChange([
      ...entries,
      {
        id: crypto.randomUUID(),
        reading: reading.trim(),
        notation: notation.trim(),
      },
    ]);
    setReading("");
    setNotation("");
  };

  const removeEntry = (id: string) => {
    onChange(entries.filter((e) => e.id !== id));
  };

  const exportDict = () => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "videoscribe-dictionary.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importDict = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (Array.isArray(data)) {
          const imported = data
            .map((d) => ({
              id: d.id || crypto.randomUUID(),
              reading: String(d.reading || ""),
              notation: String(d.notation || ""),
            }))
            .filter((d) => d.reading && d.notation);
          onChange([...entries, ...imported]);
        }
      } catch {
        /* ignore invalid json */
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        よく使う固有名詞や専門用語の「読み（誤変換されやすい表記）」と「正しい表記」を登録すると、文字起こし精度が向上します。
      </p>

      {entries.length > 0 && (
        <div className="space-y-1.5 max-h-60 overflow-y-auto">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 group"
            >
              <span className="text-sm text-slate-500 min-w-0 flex-1 truncate">
                {entry.reading}
              </span>
              <span className="text-slate-300 shrink-0">→</span>
              <span className="text-sm font-medium text-slate-900 min-w-0 flex-1 truncate">
                {entry.notation}
              </span>
              <button
                onClick={() => removeEntry(entry.id)}
                className="shrink-0 text-slate-300 hover:text-red-500 transition text-sm opacity-0 group-hover:opacity-100"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={reading}
          onChange={(e) => setReading(e.target.value)}
          placeholder="読み（例: えるさん）"
          className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          onKeyDown={(e) => e.key === "Enter" && addEntry()}
        />
        <input
          type="text"
          value={notation}
          onChange={(e) => setNotation(e.target.value)}
          placeholder="表記（例: Lさん）"
          className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          onKeyDown={(e) => e.key === "Enter" && addEntry()}
        />
        <button
          onClick={addEntry}
          disabled={!reading.trim() || !notation.trim()}
          className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          追加
        </button>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={exportDict}
          disabled={entries.length === 0}
          className="text-xs text-indigo-600 hover:text-indigo-800 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          JSONエクスポート
        </button>
        <span className="text-slate-200">|</span>
        <label className="text-xs text-indigo-600 hover:text-indigo-800 cursor-pointer transition">
          JSONインポート
          <input
            ref={importRef}
            type="file"
            accept=".json"
            onChange={importDict}
            className="hidden"
          />
        </label>
        {entries.length > 0 && (
          <>
            <span className="text-slate-200">|</span>
            <button
              onClick={() => onChange([])}
              className="text-xs text-red-500 hover:text-red-700 transition"
            >
              すべて削除
            </button>
          </>
        )}
      </div>
    </div>
  );
}
