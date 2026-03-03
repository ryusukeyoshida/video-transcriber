import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const { password } = await request.json();
  const correct = process.env.ACCESS_PASSWORD;

  if (!correct) {
    return NextResponse.json({ ok: true });
  }

  if (password === correct) {
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    { ok: false, error: "パスワードが正しくありません" },
    { status: 401 },
  );
}
