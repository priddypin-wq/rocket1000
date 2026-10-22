# ROCKET1000 voice-first assistant

A voice-first Next.js starter for the ROCKET1000 AI/MT5 trading dashboard. Talk in your Android browser and hear natural AI replies. There is no chat keyboard for day-to-day use, only a private access code field before starting a call.

## What this version does

- Start / end a real-time voice conversation, hear spoken responses and interrupt naturally.
- View live captions of the conversation when available.
- Mute/unmute the microphone.
- Ask for help planning features and writing code verbally.
- Discuss trading concepts without any live account access or trade execution.

**This is a proposed standalone web app, not a patch to a running MT5 terminal.** No live prices, EA state, trade execution or GitHub code-writing tools are connected. Verbal code requests yield *suggestions*, not automatic file modifications. No real profits or positions are displayed.

## Requirements

- Node.js 20+; Next.js 15
- OpenAI API key with access to `gpt-realtime-2.1-mini` and enabled API billing. This costs money and is separate from ChatGPT subscriptions.
- Chrome on Android (or another compatible browser), HTTPS/localhost and microphone permission.

## Local setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in:
   - `OPENAI_API_KEY` (server-side only; **never** in client-side code)
   - `VOICE_ACCESS_PIN` (a long, unpredictable secret; required to avoid publicly exposing an unauthenticated paid voice endpoint)
3. `npm run dev`
4. Visit `http://localhost:3000`, enter the access code and press **Start talking**.

## Deploy to Vercel

1. Import this repository (or connect the feature branch as a preview).
2. Configure `OPENAI_API_KEY` and `VOICE_ACCESS_PIN` in Vercel Project Settings -> Environment Variables (do not commit them).
3. Enable appropriate deployment protection; the PIN is only a lightweight gate, not a complete multi-user authentication system.
4. Deploy, then open the **HTTPS** URL on Android, enter the access code once, allow mic access and speak.

The existing Vercel project is under a team scope that needs renewed authorization before an automated deployment can be verified. Do not overwrite an existing production deployment until the source and team access are confirmed.

## Safety and privacy

- The voice session streams microphone audio to OpenAI after the user explicitly starts it.
- Captions are local to the open page and are not saved in a database by this starter.
- API usage is metered and may incur costs. Set project spend limits / monitor usage.
- The server checks `VOICE_ACCESS_PIN` before opening an API session. For public/multi-user launch, add full authentication and rate limiting.
- MT5 order placement and repository write actions are intentionally **not** wired up. Require independent risk checks and explicit confirmation for any future trading automation.
- The browser only requests microphone access when **Start talking** is pressed, and stops microphone tracks when **End conversation** is selected.

See [OpenAI's Realtime WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc) for the underlying audio connection.
