import { NextRequest, NextResponse } from "next/server";
import OpenAI, { toFile } from "openai";
import { YoutubeTranscript } from "youtube-transcript";
import { Innertube } from "youtubei.js";

export const maxDuration = 120;

interface DictEntry {
  reading: string;
  notation: string;
}

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY が設定されていません。.env.local を確認してください。" },
        { status: 500 },
      );
    }

    const accessPassword = process.env.ACCESS_PASSWORD;
    const formData = await request.formData();
    const password = formData.get("password") as string | null;

    if (accessPassword && password !== accessPassword) {
      return NextResponse.json(
        { error: "認証に失敗しました。パスワードを確認してください。" },
        { status: 401 },
      );
    }

    const file = formData.get("file") as File | null;
    const url = formData.get("url") as string | null;
    const dictionaryStr = formData.get("dictionary") as string | null;

    let dictionary: DictEntry[] = [];
    if (dictionaryStr) {
      try {
        dictionary = JSON.parse(dictionaryStr);
      } catch {
        /* ignore */
      }
    }

    const ytMatch = url?.match(
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]+)/,
    );
    if (ytMatch && !file) {
      return handleYouTube(url!, ytMatch[1], dictionary, apiKey);
    }

    let audioFile: Awaited<ReturnType<typeof toFile>>;

    if (file) {
      const buffer = Buffer.from(await file.arrayBuffer());
      audioFile = await toFile(buffer, file.name, { type: file.type });
    } else if (url) {
      const result = await downloadFromUrl(url);
      if ("error" in result) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      audioFile = result.file;
    } else {
      return NextResponse.json(
        { error: "ファイルまたはURLを指定してください" },
        { status: 400 },
      );
    }

    const prompt =
      dictionary.length > 0
        ? dictionary.map((e) => e.notation).join("、")
        : undefined;

    const openai = new OpenAI({ apiKey });

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      language: "ja",
      ...(prompt ? { prompt } : {}),
    });

    let text = transcription.text;
    text = applyDictionary(text, dictionary);

    return NextResponse.json({ text });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "文字起こし中にエラーが発生しました";
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("Transcription error:", err);
    return NextResponse.json(
      {
        error: message,
        debug: {
          type: err instanceof Error ? err.constructor.name : typeof err,
          stack: stack?.split("\n").slice(0, 5).join("\n"),
        },
      },
      { status: 500 },
    );
  }
}

async function handleYouTube(
  originalUrl: string,
  videoId: string,
  dictionary: DictEntry[],
  apiKey: string,
): Promise<NextResponse> {
  const log: { step: string; result: string }[] = [];

  // --- Step 1: YouTube字幕を試行 ---
  for (const lang of ["ja", undefined]) {
    try {
      const segments = await YoutubeTranscript.fetchTranscript(videoId, {
        ...(lang ? { lang } : {}),
      });

      if (segments && segments.length > 0) {
        let text = segments.map((s) => s.text).join(" ");
        text = text.replace(/\s+/g, " ").trim();
        text = applyDictionary(text, dictionary);

        return NextResponse.json({
          text,
          note: `YouTube字幕データから取得（lang=${lang ?? "auto"}, ${segments.length}セグメント）`,
        });
      }
      log.push({
        step: `字幕取得(lang=${lang ?? "auto"})`,
        result: "字幕データが空",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.push({ step: `字幕取得(lang=${lang ?? "auto"})`, result: msg });
    }
  }

  // --- Step 2: InnerTube API で字幕を取得 ---
  try {
    log.push({ step: "InnerTube字幕", result: "接続中..." });

    const yt = await Innertube.create({
      lang: "ja",
      location: "JP",
      retrieve_player: false,
    });

    const info = await yt.getInfo(videoId);
    const transcriptData = await info.getTranscript();

    const body = transcriptData?.transcript?.content?.body;
    const segments =
      body && "initial_segments" in body ? body.initial_segments : [];

    if (segments && segments.length > 0) {
      const textParts: string[] = [];
      for (const seg of segments) {
        if ("snippet" in seg && seg.snippet?.text) {
          textParts.push(seg.snippet.text);
        }
      }

      if (textParts.length > 0) {
        let text = textParts.join(" ").replace(/\s+/g, " ").trim();
        text = applyDictionary(text, dictionary);

        log.push({
          step: "InnerTube字幕",
          result: `成功（${textParts.length}セグメント）`,
        });

        return NextResponse.json({
          text,
          note: `InnerTube経由でYouTube字幕を取得（${textParts.length}セグメント）`,
        });
      }
    }

    log.push({
      step: "InnerTube字幕",
      result: `字幕データなし（segments=${segments?.length ?? 0}）`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.push({ step: "InnerTube字幕", result: `エラー: ${msg}` });
  }

  // --- Step 3: cobalt APIで音声ダウンロード → Whisper ---
  const cobaltUrl =
    process.env.COBALT_API_URL || "https://api.cobalt.tools";

  try {
    log.push({ step: "cobalt API", result: `${cobaltUrl} にリクエスト中...` });

    const cobaltRes = await fetch(cobaltUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: originalUrl,
        downloadMode: "audio",
        audioFormat: "mp3",
        audioBitrate: "128",
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const cobaltData = await cobaltRes.json();

    if (
      cobaltData.status === "tunnel" ||
      cobaltData.status === "redirect"
    ) {
      const audioUrl = cobaltData.url;
      log.push({
        step: "cobalt API",
        result: `成功（status=${cobaltData.status}）`,
      });

      const audioRes = await fetch(audioUrl, {
        signal: AbortSignal.timeout(90_000),
      });

      if (!audioRes.ok) {
        log.push({
          step: "cobalt音声ダウンロード",
          result: `失敗（status=${audioRes.status}）`,
        });
      } else {
        const buffer = Buffer.from(await audioRes.arrayBuffer());
        log.push({
          step: "cobalt音声ダウンロード",
          result: `成功（${(buffer.length / 1024 / 1024).toFixed(1)}MB）`,
        });

        const audioFile = await toFile(buffer, "youtube-audio.mp3", {
          type: "audio/mp3",
        });

        const prompt =
          dictionary.length > 0
            ? dictionary.map((e) => e.notation).join("、")
            : undefined;

        const openai = new OpenAI({ apiKey });
        const transcription = await openai.audio.transcriptions.create({
          file: audioFile,
          model: "whisper-1",
          language: "ja",
          ...(prompt ? { prompt } : {}),
        });

        let text = transcription.text;
        text = applyDictionary(text, dictionary);

        return NextResponse.json({
          text,
          note: "cobalt経由でYouTube音声を取得し、Whisperで文字起こししました。",
        });
      }
    } else {
      const errCode = cobaltData.error?.code || cobaltData.status;
      log.push({
        step: "cobalt API",
        result: `失敗（${errCode}）`,
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.push({ step: "cobalt API", result: `エラー: ${msg}` });
  }

  // --- Step 3: InnerTube API（getInfo）で音声ダウンロード → Whisper ---
  try {
    log.push({ step: "InnerTube", result: "接続中..." });

    const yt = await Innertube.create({
      lang: "ja",
      location: "JP",
      retrieve_player: true,
    });

    const info = await yt.getInfo(videoId);

    const adaptiveCount =
      info.streaming_data?.adaptive_formats?.length ?? 0;
    const allFormats = info.streaming_data?.adaptive_formats ?? [];
    const audioFormats = allFormats.filter(
      (f) => f.has_audio && !f.has_video,
    );

    log.push({
      step: "InnerTube情報取得",
      result: `adaptive=${adaptiveCount}, audio=${audioFormats.length}, formats=${JSON.stringify(allFormats.map((f) => ({ mime: f.mime_type, audio: f.has_audio, video: f.has_video })).slice(0, 5))}`,
    });

    if (audioFormats.length === 0) {
      log.push({
        step: "InnerTube",
        result: "音声フォーマットが見つかりません",
      });
    } else {
      const format = audioFormats[0];
      const contentLength = format.content_length ?? 0;
      log.push({
        step: "InnerTube",
        result: `フォーマット取得成功（${format.mime_type}, ${(contentLength / 1024 / 1024).toFixed(1)}MB）`,
      });

      const stream = await info.download({
        type: "audio",
        quality: "bestefficiency",
      });
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const buffer = Buffer.concat(chunks);

      log.push({
        step: "InnerTube音声ダウンロード",
        result: `成功（${(buffer.length / 1024 / 1024).toFixed(1)}MB）`,
      });

      const ext = format.mime_type?.includes("webm") ? "webm" : "m4a";
      const audioFile = await toFile(buffer, `youtube-audio.${ext}`, {
        type: format.mime_type?.split(";")[0] || `audio/${ext}`,
      });

      const prompt =
        dictionary.length > 0
          ? dictionary.map((e) => e.notation).join("、")
          : undefined;

      const openai = new OpenAI({ apiKey });
      const transcription = await openai.audio.transcriptions.create({
        file: audioFile,
        model: "whisper-1",
        language: "ja",
        ...(prompt ? { prompt } : {}),
      });

      let text = transcription.text;
      text = applyDictionary(text, dictionary);

      return NextResponse.json({
        text,
        note: "InnerTube経由でYouTube音声を取得し、Whisperで文字起こししました。",
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.push({ step: "InnerTube", result: `エラー: ${msg}` });
  }

  // --- すべて失敗 ---
  console.error(
    `YouTube handling failed for ${videoId}:\n` +
      log.map((l) => `  [${l.step}] ${l.result}`).join("\n"),
  );

  return NextResponse.json(
    {
      error: [
        "YouTube動画の自動文字起こしに失敗しました。",
        "",
        "以下の方法でお試しください：",
        "1. cobalt.tools（ https://cobalt.tools ）で動画をダウンロード",
        "2. ダウンロードしたファイルを「ファイルアップロード」タブで送信",
      ].join("\n"),
      debug: {
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        cobaltDownload: `https://cobalt.tools`,
        log,
      },
    },
    { status: 400 },
  );
}

async function downloadFromUrl(
  url: string,
): Promise<{ file: Awaited<ReturnType<typeof toFile>> } | { error: string }> {
  const loomMatch = url.match(/loom\.com\/share\/([a-zA-Z0-9]+)/);
  if (loomMatch) {
    return downloadFromLoom(loomMatch[1]);
  }

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "VideoScribe/1.0" },
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      return {
        error: `URLからのダウンロードに失敗しました（ステータス: ${response.status}）`,
      };
    }

    const contentType = response.headers.get("content-type") || "";
    if (
      !contentType.includes("audio") &&
      !contentType.includes("video") &&
      !contentType.includes("octet-stream")
    ) {
      return {
        error:
          "このURLは音声・動画ファイルではないようです。直接メディアファイルのURLを指定してください。",
      };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const ext = extFromContentType(contentType);
    const file = await toFile(buffer, `download.${ext}`, {
      type: contentType,
    });
    return { file };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `URLからのダウンロードに失敗しました: ${msg}` };
  }
}

async function downloadFromLoom(
  videoId: string,
): Promise<{ file: Awaited<ReturnType<typeof toFile>> } | { error: string }> {
  try {
    const pageRes = await fetch(`https://www.loom.com/share/${videoId}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!pageRes.ok) {
      return { error: "Loom動画のページを取得できませんでした" };
    }

    const html = await pageRes.text();

    const videoUrlMatch = html.match(
      /"url"\s*:\s*"(https:\/\/cdn\.loom\.com\/sessions\/[^"]+\.mp4[^"]*)"/,
    );
    if (!videoUrlMatch) {
      return {
        error:
          "Loom動画のダウンロードURLを取得できませんでした。動画をダウンロードしてからファイルアップロードをご利用ください。",
      };
    }

    const videoUrl = videoUrlMatch[1].replace(/\\u002F/g, "/");
    const videoRes = await fetch(videoUrl, {
      signal: AbortSignal.timeout(120_000),
    });

    if (!videoRes.ok) {
      return { error: "Loom動画のダウンロードに失敗しました" };
    }

    const buffer = Buffer.from(await videoRes.arrayBuffer());
    const file = await toFile(buffer, "loom-video.mp4", {
      type: "video/mp4",
    });
    return { file };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Loom動画の取得に失敗しました: ${msg}` };
  }
}

function applyDictionary(text: string, dictionary: DictEntry[]): string {
  let result = text;
  for (const entry of dictionary) {
    if (entry.reading && entry.notation && entry.reading !== entry.notation) {
      result = result.replaceAll(entry.reading, entry.notation);
    }
  }
  return result;
}

function extFromContentType(ct: string): string {
  if (ct.includes("mp4")) return "mp4";
  if (ct.includes("mp3") || ct.includes("mpeg")) return "mp3";
  if (ct.includes("wav")) return "wav";
  if (ct.includes("webm")) return "webm";
  if (ct.includes("m4a")) return "m4a";
  if (ct.includes("ogg")) return "ogg";
  return "mp4";
}
