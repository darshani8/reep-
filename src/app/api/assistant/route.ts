/**
 * POST /api/assistant — thin backend wrapper around the dual-mode assistant.
 *
 * The browser calls THIS route; this route calls the assistant module, which
 * holds GEMINI_API_KEY. The key never reaches the client.
 *
 * Body:  { question: string, db?: WaterDbContext, mode?: "general" | "water" }
 * Reply: { card, sources, grounded, mode }  (AssistantResult)
 *
 * Node runtime (not Edge): the @google/genai SDK targets Node, not the Edge runtime.
 */

import { NextResponse } from "next/server";
import { askAssistant, type AskAssistantInput } from "@/lib/ai/gemini-assistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // never cache model output

export async function POST(req: Request): Promise<NextResponse> {
  let body: Partial<AskAssistantInput>;
  try {
    body = (await req.json()) as Partial<AskAssistantInput>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const question = typeof body.question === "string" ? body.question : "";
  if (!question.trim()) {
    return NextResponse.json({ error: "`question` is required." }, { status: 400 });
  }

  // Only forward known fields; `mode` is validated so junk can't force a mode.
  const mode = body.mode === "general" || body.mode === "water" ? body.mode : undefined;

  // askAssistant never throws to the UI (it returns a deterministic fallback),
  // so a 200 with a fallback card is the normal failure surface here.
  const result = await askAssistant({ question, db: body.db ?? undefined, mode });
  return NextResponse.json(result, { status: 200 });
}
