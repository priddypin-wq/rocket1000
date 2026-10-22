"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type TranscriptItem = {
  id: string;
  speaker: "you" | "assistant";
  text: string;
};

type ServerEvent = {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
};

export default function Home() {
  const [accessCode, setAccessCode] = useState("");
  const [starting, setStarting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [muted, setMuted] = useState(false);
  const [status, setStatus] = useState("Your voice assistant is ready to connect.");
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const connectingRef = useRef(false);

  const stop = useCallback(() => {
    channelRef.current?.close();
    channelRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    micRef.current?.getTracks().forEach((track) => track.stop());
    micRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
      audioRef.current = null;
    }
    connectingRef.current = false;
    setStarting(false);
    setConnected(false);
    setMuted(false);
    setStatus("Conversation ended. Press Start talking to reconnect.");
  }, []);

  useEffect(() => () => stop(), [stop]);

  const appendTranscript = useCallback((id: string, speaker: TranscriptItem["speaker"], text: string, append = false) => {
    if (!text) return;
    setTranscript((current) => {
      const found = current.findIndex((item) => item.id === id);
      if (found < 0) {
        return [...current, { id, speaker, text }].slice(-30);
      }
      const updated = [...current];
      updated[found] = {
        ...updated[found],
        text: append ? updated[found].text + text : text
      };
      return updated;
    });
  }, []);

  const onEvent = useCallback((raw: string) => {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    if (event.type === "input_audio_buffer.speech_started") {
      setStatus("Listening to you...");
    } else if (event.type === "input_audio_buffer.speech_stopped") {
      setStatus("Thinking...");
    } else if (event.type === "response.created") {
      setStatus("Assistant is speaking...");
    } else if (event.type === "response.done") {
      setStatus("Ready — talk whenever you like.");
    } else if (event.type === "conversation.item.input_audio_transcription.completed") {
      appendTranscript(event.item_id ?? crypto.randomUUID(), "you", event.transcript ?? "");
    } else if (event.type === "response.output_audio_transcript.delta") {
      appendTranscript(event.item_id ?? "assistant-current", "assistant", event.delta ?? "", true);
    } else if (event.type === "error") {
      setError(event.error?.message ?? "A voice service error occurred.");
    }
  }, [appendTranscript]);

  const start = useCallback(async () => {
    if (connectingRef.current || pcRef.current) return;
    if (!accessCode.trim()) {
      setError("Enter your private access code once to unlock voice calls.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      setError("Your browser does not support microphone voice calls. Open this app in an up-to-date Chrome browser on Android.");
      return;
    }

    connectingRef.current = true;
    setStarting(true);
    setError("");
    setStatus("Requesting microphone permission...");

    try {
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      micRef.current = microphone;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      pc.addTrack(microphone.getAudioTracks()[0], microphone);

      const player = new Audio();
      player.autoplay = true;
      audioRef.current = player;
      pc.ontrack = (event) => {
        player.srcObject = event.streams[0];
        void player.play().catch(() => setError("Tap the screen to allow audio playback."));
      };

      const channel = pc.createDataChannel("oai-events");
      channelRef.current = channel;
      channel.onmessage = (event: MessageEvent<string>) => onEvent(event.data);
      channel.onopen = () => {
        setConnected(true);
        setStarting(false);
        setStatus("Connected! Say hello, or ask me to help code ROCKET1000.");
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          setError("Voice connection ended. You can reconnect.");
          stop();
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!offer.sdp) throw new Error("The microphone could not start a voice session.");

      setStatus("Connecting your voice assistant...");
      const result = await fetch("/api/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/sdp",
          "x-voice-access-code": accessCode
        },
        body: offer.sdp
      });

      if (!result.ok) {
        const payload = await result.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? "Could not connect to the voice service.");
      }

      await pc.setRemoteDescription({ type: "answer", sdp: await result.text() });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Microphone access failed.";
      stop();
      setError(message);
    } finally {
      connectingRef.current = false;
      setStarting(false);
    }
  }, [accessCode, onEvent, stop]);

  const toggleMute = () => {
    if (!micRef.current) return;
    const next = !muted;
    micRef.current.getAudioTracks().forEach((track) => { track.enabled = !next; });
    setMuted(next);
    setStatus(next ? "Microphone muted." : "Microphone on — speak naturally.");
  };

  return (
    <main className="page">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">R</span>
          <div><strong>ROCKET1000</strong><small>Voice-first AI assistant</small></div>
        </div>
        <span className="top-pill">PRIVATE VOICE BETA</span>
      </header>

      <div className="shell">
        <section className="hero">
          <div className="eyebrow"><span className="status-light" /> A smarter way to control your workspace</div>
          <h1>Talk to your assistant.<br /><span>Skip the typing.</span></h1>
          <p>Ask questions, plan features and talk through code changes naturally, just like a voice conversation.</p>
        </section>

        <section className="voice-card" aria-label="Voice assistant controls">
          <div className={`orb ${connected ? "orb-active" : ""}`} aria-hidden="true">
            <span className="orb-center">🎙</span>
          </div>
          <h2>{connected ? "Your assistant is listening" : "Your assistant, your voice"}</h2>
          <p className="status" role="status">{status}</p>

          {!connected && (
            <label className="access-field">
              <span>Private access code (one-time per session)</span>
              <input
                aria-label="Private access code"
                autoComplete="off"
                type="password"
                value={accessCode}
                onChange={(event) => setAccessCode(event.target.value)}
                placeholder="Enter your access code"
              />
            </label>
          )}

          <div className="controls">
            {!connected ? (
              <button className="primary" onClick={() => void start()} disabled={starting}>
                {starting ? "Connecting..." : "🎙 Start talking"}
              </button>
            ) : (
              <>
                <button className="secondary" onClick={toggleMute}>{muted ? "Unmute microphone" : "Mute microphone"}</button>
                <button className="danger" onClick={stop}>End conversation</button>
              </>
            )}
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <p className="hint">Allow microphone access when asked. Your assistant will speak back to you automatically.</p>
        </section>

        <div className="bottom-grid">
          <section className="panel">
            <h3>Try saying...</h3>
            <div className="example">“Help me build a new feature for ROCKET1000.”</div>
            <div className="example">“Explain my MT5 risk settings.”</div>
            <div className="example">“How can I improve my app's dashboard?”</div>
            <p className="panel-note">Requests about coding are advisory. No code is changed or published automatically.</p>
          </section>

          <section className="panel transcript-panel">
            <div className="panel-heading">
              <h3>Live conversation</h3>
              <button className="clear" onClick={() => setTranscript([])}>Clear</button>
            </div>
            <div className="transcript" aria-live="polite">
              {transcript.length === 0 ? (
                <p className="empty">Your conversation captions will appear here when the call starts.</p>
              ) : transcript.map((item) => (
                <div key={item.id} className={`bubble ${item.speaker === "you" ? "bubble-user" : "bubble-ai"}`}>
                  <span>{item.speaker === "you" ? "You" : "ROCKET1000"}</span>
                  <p>{item.text}</p>
                </div>
              ))}
            </div>
          </section>
        </div>

        <footer>Voice uses your microphone and the OpenAI API. Paid API usage applies. MT5 and live trading execution are not connected.</footer>
      </div>
    </main>
  );
}
