import { NextRequest, NextResponse } from "next/server";
import OpenAI, { toFile } from "openai";
import ytdl from "@distube/ytdl-core";

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

    let dictionary: DictEntry[] = [];
    if (dictionaryStr) {
      try {
        dictionary = JSON.parse(dictionaryStr);
      } catch {
        /* ignore parse errors */
      }
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
    for (const entry of dictionary) {
      if (entry.reading && entry.notation && entry.reading !== entry.notation) {
        text = text.replaceAll(entry.reading, entry.notation);
      }
    }

    return NextResponse.json({ text });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "文字起こし中にエラーが発生しました";
    console.error("Transcription error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function downloadFromUrl(
  url: string,
): Promise<{ file: Awaited<ReturnType<typeof toFile>> } | { error: string }> {
  const ytMatch = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]+)/,
  );
  if (ytMatch) {
    return downloadFromYouTube(url);
  }

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

async function downloadFromYouTube(
  url: string,
): Promise<{ file: Awaited<ReturnType<typeof toFile>> } | { error: string }> {
  try {
    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title || "youtube-audio";

    const format = ytdl.chooseFormat(info.formats, {
      quality: "lowestaudio",
      filter: "audioonly",
    });

    if (!format) {
      return {
        error:
          "YouTube動画の音声フォーマットを取得できませんでした。動画をダウンロードしてファイルアップロードをお試しください。",
      };
    }

    const stream = ytdl.downloadFromInfo(info, { format });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    const ext =
      format.container === "webm"
        ? "webm"
        : format.container === "mp4"
          ? "m4a"
          : "mp3";

    const file = await toFile(buffer, `${title}.${ext}`, {
      type: format.mimeType?.split(";")[0] || `audio/${ext}`,
    });
    return { file };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error: `YouTube動画の取得に失敗しました: ${msg}\n\n動画をダウンロードしてファイルアップロードをお試しください。`,
    };
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

function extFromContentType(ct: string): string {
  if (ct.includes("mp4")) return "mp4";
  if (ct.includes("mp3") || ct.includes("mpeg")) return "mp3";
  if (ct.includes("wav")) return "wav";
  if (ct.includes("webm")) return "webm";
  if (ct.includes("m4a")) return "m4a";
  if (ct.includes("ogg")) return "ogg";
  return "mp4";
}
