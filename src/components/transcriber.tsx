"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { DictionaryManager } from "./dictionary-manager";
import {
  type DictionaryEntry,
  loadDictionary,
  saveDictionary,
} from "@/lib/dictionary";

type InputTab = "file" | "url";
type Status = "idle" | "processing" | "done" | "error";

const ACCEPTED =
  ".mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm,.ogg,.mov,.avi,.mkv,.flac,.aac";
const MAX_SIZE = 25 * 1024 * 1024;
const SESSION_KEY = "videoscribe-auth";

export function Transcriber() {
  const [authed, setAuthed] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [pwInput, setPwInput] = useState("");

  const [tab, setTab] = useState<InputTab>("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [errorDebug, setErrorDebug] = useState<Record<string, unknown> | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [dictionary, setDictionary] = useState<DictionaryEntry[]>([]);
  const [showDict, setShowDict] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>(null);

  useEffect(() => {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) {
      verifyPassword(saved).then((ok) => {
        if (ok) setAuthed(true);
        setAuthLoading(false);
      });
    } else {
      verifyPassword("").then((ok) => {
        if (ok) setAuthed(true);
        setAuthLoading(false);
      });
    }
  }, []);

  async function verifyPassword(pw: string): Promise<boolean> {
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const data = await res.json();
      return data.ok === true;
    } catch {
      return false;
    }
  }

  const handleLogin = async () => {
    setAuthError("");
    setAuthLoading(true);
    const ok = await verifyPassword(pwInput);
    if (ok) {
      sessionStorage.setItem(SESSION_KEY, pwInput);
      setAuthed(true);
    } else {
      setAuthError("パスワードが正しくありません");
    }
    setAuthLoading(false);
  };

  useEffect(() => {
    setDictionary(loadDictionary());
  }, []);

  useEffect(() => {
    saveDictionary(dictionary);
  }, [dictionary]);

  useEffect(() => {
    if (status === "processing") {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((t) => t + 1), 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [status]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) {
      setFile(dropped);
      setTab("file");
    }
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) setFile(f);
    },
    [],
  );

  const canSubmit =
    status !== "processing" && (tab === "file" ? !!file : !!url.trim());

  const handleTranscribe = async () => {
    setStatus("processing");
    setError("");
    setErrorDebug(null);
    setShowDebug(false);
    setResult("");
    setNote("");

    try {
      const formData = new FormData();

      if (tab === "file") {
        if (!file) throw new Error("ファイルを選択してください");
        if (file.size > MAX_SIZE) {
          throw new Error(
            `ファイルサイズが大きすぎます（${fmtSize(file.size)}）。Whisper APIの上限は25MBです。音声のみを抽出するか、分割してお試しください。`,
          );
        }
        formData.append("file", file);
      } else {
        if (!url.trim()) throw new Error("URLを入力してください");
        formData.append("url", url.trim());
      }

      if (dictionary.length > 0) {
        formData.append("dictionary", JSON.stringify(dictionary));
      }

      const savedPw = sessionStorage.getItem(SESSION_KEY) || "";
      formData.append("password", savedPw);

      const res = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        if (data.debug) setErrorDebug(data.debug);
        throw new Error(data.error || "文字起こしに失敗しました");
      }

      setResult(data.text);
      if (data.note) setNote(data.note);
      setStatus("done");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
      setStatus("error");
    }
  };

  const copyResult = async () => {
    await navigator.clipboard.writeText(result);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadResult = () => {
    const blob = new Blob([result], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `transcription_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(href);
  };

  if (!authed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-indigo-50/30 px-4">
        <div className="w-full max-w-sm space-y-6 text-center">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              <span className="text-indigo-600">Video</span>Scribe
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              パスワードを入力してください
            </p>
          </div>
          {!authLoading && (
            <div className="space-y-3">
              <input
                type="password"
                value={pwInput}
                onChange={(e) => setPwInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                placeholder="パスワード"
                autoFocus
                className="w-full rounded-xl border border-slate-200 px-4 py-3 text-center text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
              {authError && (
                <p className="text-sm text-red-600">{authError}</p>
              )}
              <button
                onClick={handleLogin}
                className="w-full rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-md shadow-indigo-600/20 transition hover:bg-indigo-700 active:scale-[0.99]"
              >
                ログイン
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50/30">
      <header className="sticky top-0 z-10 border-b border-slate-200/60 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-2xl items-baseline gap-3 px-4 py-5">
          <h1 className="text-xl font-bold tracking-tight text-slate-900">
            <span className="text-indigo-600">Video</span>Scribe
          </h1>
          <span className="text-xs text-slate-400">動画・音声の文字起こし</span>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-5 px-4 py-8">
        {/* --- Input --- */}
        <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/80">
          <div className="flex border-b border-slate-100">
            {(["file", "url"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 px-4 py-3 text-sm font-medium transition ${
                  tab === t
                    ? "border-b-2 border-indigo-600 text-indigo-600"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {t === "file" ? "ファイルアップロード" : "URLから取得"}
              </button>
            ))}
          </div>

          <div className="p-5">
            {tab === "file" ? (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
                className={`cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-all ${
                  dragOver
                    ? "border-indigo-400 bg-indigo-50/60 scale-[1.01]"
                    : file
                      ? "border-emerald-300 bg-emerald-50/40"
                      : "border-slate-200 hover:border-indigo-300 hover:bg-slate-50/50"
                }`}
              >
                <input
                  ref={fileRef}
                  type="file"
                  accept={ACCEPTED}
                  onChange={handleFileChange}
                  className="hidden"
                />
                {file ? (
                  <>
                    <div className="mb-2 text-2xl text-emerald-500">✓</div>
                    <p className="text-sm font-medium text-emerald-700">
                      {file.name}
                    </p>
                    <p className="mt-0.5 text-xs text-emerald-600">
                      {fmtSize(file.size)}
                    </p>
                    <p className="mt-2 text-[11px] text-slate-400">
                      クリックで変更
                    </p>
                  </>
                ) : (
                  <>
                    <div className="mb-2 text-3xl">🎬</div>
                    <p className="text-sm text-slate-600">
                      ドラッグ＆ドロップ、またはクリックしてファイルを選択
                    </p>
                    <p className="mt-2 text-[11px] text-slate-400">
                      MP4, MP3, WAV, M4A, WebM, OGG など（最大25MB）
                    </p>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" && canSubmit && handleTranscribe()
                  }
                  placeholder="https://..."
                  className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
                <p className="text-[11px] leading-relaxed text-slate-400">
                  YouTube、Loomシェアリンク、音声/動画ファイルの直接URLに対応
                </p>
              </div>
            )}
          </div>
        </section>

        {/* --- Dictionary --- */}
        <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/80">
          <button
            onClick={() => setShowDict(!showDict)}
            className="flex w-full items-center justify-between px-5 py-4 text-left transition hover:bg-slate-50/50"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-800">
                カスタム辞書
              </span>
              {dictionary.length > 0 && (
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
                  {dictionary.length}
                </span>
              )}
            </div>
            <svg
              className={`h-4 w-4 text-slate-400 transition-transform ${showDict ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
          {showDict && (
            <div className="border-t border-slate-100 px-5 py-4">
              <DictionaryManager
                entries={dictionary}
                onChange={setDictionary}
              />
            </div>
          )}
        </section>

        {/* --- Submit --- */}
        <button
          onClick={handleTranscribe}
          disabled={!canSubmit}
          className="w-full rounded-2xl bg-indigo-600 px-6 py-4 text-sm font-semibold text-white shadow-md shadow-indigo-600/20 transition hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-600/25 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
        >
          {status === "processing" ? (
            <span className="flex items-center justify-center gap-2">
              <svg
                className="h-4 w-4 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              文字起こし中…（{elapsed}秒）
            </span>
          ) : (
            "文字起こしを開始"
          )}
        </button>

        {/* --- Error --- */}
        {error && (
          <div className="rounded-2xl bg-red-50 px-5 py-4 ring-1 ring-red-200/60 space-y-3">
            <p className="text-sm leading-relaxed text-red-700 whitespace-pre-wrap">
              {error}
            </p>
            {"cobaltDownload" in (errorDebug ?? {}) && errorDebug && (
              <a
                href={String(errorDebug.cobaltDownload)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-red-700"
              >
                cobalt.tools で動画をダウンロード
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
              </a>
            )}
            {errorDebug && (
              <div>
                <button
                  onClick={() => setShowDebug(!showDebug)}
                  className="text-[11px] text-red-500 hover:text-red-700 transition underline"
                >
                  {showDebug ? "デバッグ情報を閉じる" : "デバッグ情報を表示"}
                </button>
                {showDebug && (
                  <pre className="mt-2 rounded-lg bg-red-100/50 p-3 text-[11px] leading-relaxed text-red-800 overflow-x-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(errorDebug, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}

        {/* --- Result --- */}
        {result && (
          <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/80">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
              <h2 className="text-sm font-semibold text-slate-800">
                文字起こし結果
              </h2>
              <div className="flex gap-1.5">
                <button
                  onClick={copyResult}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
                >
                  {copied ? "✓ コピー済み" : "コピー"}
                </button>
                <button
                  onClick={downloadResult}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
                >
                  ダウンロード
                </button>
              </div>
            </div>
            <div className="p-5 space-y-3">
              {note && (
                <p className="text-[11px] text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                  {note}
                </p>
              )}
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="whitespace-pre-wrap text-sm leading-7 text-slate-800">
                  {result}
                </p>
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="border-t border-slate-100 py-6 text-center text-[11px] text-slate-400">
        Powered by OpenAI Whisper
      </footer>
    </div>
  );
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
