import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VOICE_INSTRUCTIONS = [
  "You are ROCKET1000's friendly voice-first AI assistant.",
  "Speak naturally and clearly with short, useful conversational answers.",
  "The user may speak requests about developing the ROCKET1000 app. Help plan code changes and explain them in simple steps; you cannot edit repositories, deploy, or claim changes are made.",
  "You may explain trading concepts and risk management but do not give personalized financial advice or claim live account, balance, price, trade, or market access.",
  "NEVER place orders, initiate transfers, change EA or MT5 settings, or imply a spoken instruction has executed an action.",
  "No tools are connected. All code and trading suggestions are proposals until implemented and verified separately.",
  "Never invent live data, market signals or guaranteed profits.",
  "The user is often on Android and prefers conversation without typing.",
].join(" ");

function sameSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  const accessPin = process.env.VOICE_ACCESS_PIN;
  if (!apiKey || !accessPin) {
    return Response.json(
      { error: "Voice is not configured. Add OPENAI_API_KEY and VOICE_ACCESS_PIN on your server." },
      { status: 503 }
    );
  }

  if (!sameSecret(request.headers.get("x-voice-access-code") ?? "", accessPin)) {
    return Response.json({ error: "Incorrect access code." }, { status: 401 });
  }

  if (request.headers.get("content-type") !== "application/sdp") {
    return Response.json({ error: "Expected WebRTC SDP." }, { status: 415 });
  }

  const offer = await request.text();
  if (offer.length < 30 || offer.length > 30000 || !offer.includes("v=0")) {
    return Response.json({ error: "Invalid WebRTC offer." }, { status: 400 });
  }

  const form = new FormData();
  form.append("sdp", offer);
  form.append(
    "session",
    JSON.stringify({
      type: "realtime",
      model: "gpt-realtime-2.1-mini",
      instructions: VOICE_INSTRUCTIONS,
      audio: {
        input: { transcription: { model: "gpt-4o-mini-transcribe" } },
        output: { voice: "marin" }
      }
    })
  );

  try {
    const upstream = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      cache: "no-store"
    });

    if (!upstream.ok) {
      console.error("OpenAI voice connection failed:", upstream.status);
      return Response.json(
        { error: "The voice service could not connect. Check model access, API billing and server logs." },
        { status: 502 }
      );
    }

    const answer = await upstream.text();
    return new Response(answer, {
      status: 200,
      headers: { "Content-Type": "application/sdp", "Cache-Control": "no-store" }
    });
  } catch {
    return Response.json({ error: "Network error connecting to the voice service." }, { status: 502 });
  }
}
