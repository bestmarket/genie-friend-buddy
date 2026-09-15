const GATEWAY = "https://ai.gateway.lovable.dev/v1";

function apiKey(): string {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("AI is not configured for this project yet.");
  return key;
}

async function gatewayError(res: Response): Promise<Error> {
  let message = `AI request failed (${res.status})`;
  try {
    const body = (await res.json()) as {
      message?: string;
      error?: { message?: string };
    };
    message = body.error?.message ?? body.message ?? message;
  } catch {
    /* keep default */
  }
  if (res.status === 429) return new Error("The AI is busy right now. Try again in a moment.");
  if (res.status === 402)
    return new Error("You've run out of AI credits. Add more credits to keep generating.");
  if (res.status === 403) return new Error(`AI access is blocked: ${message}`);
  return new Error(message);
}

/** Streams a text answer from the writing model and returns the full text. */
export async function askAI(system: string, prompt: string): Promise<string> {
  const res = await fetch(`${GATEWAY}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": apiKey(),
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify({
      model: "openai/gpt-6-astra",
      instructions: system,
      input: prompt,
      stream: true,
      reasoning: { effort: "low" },
    }),
  });

  if (!res.ok || !res.body) throw await gatewayError(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const event = JSON.parse(payload) as { type?: string; delta?: string };
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          text += event.delta;
        }
      } catch {
        /* ignore partial frames */
      }
    }
  }

  return text.trim();
}

function extractJson(raw: string): unknown {
  const cleaned = raw
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    if (start === -1 || end === -1) throw new Error("The AI returned an unexpected answer.");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

/** Asks the writing model for JSON and parses it. */
export async function askAIJson<T>(system: string, prompt: string): Promise<T> {
  const raw = await askAI(
    `${system}\n\nAlways reply with valid JSON only. No markdown fences, no commentary.`,
    prompt,
  );
  return extractJson(raw) as T;
}

/** Generates one scene image and returns raw PNG bytes. */
export async function generateSceneImage(prompt: string): Promise<Uint8Array> {
  const res = await fetch(`${GATEWAY}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": apiKey(),
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify({
      model: "lovable/image-fast",
      prompt,
      size: "1536x1024",
      n: 1,
    }),
  });

  if (!res.ok) throw await gatewayError(res);

  const body = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new Error("The image could not be generated.");

  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Generates narration audio and returns raw WAV bytes. */
export async function generateNarration(text: string, voice: string): Promise<Uint8Array> {
  const res = await fetch(`${GATEWAY}/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": apiKey(),
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-tts",
      contents: [
        {
          role: "user",
          parts: [{ text: `Read this aloud in a warm, confident narrator voice:\n\n${text}` }],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
  });

  if (!res.ok) throw await gatewayError(res);
  return new Uint8Array(await res.arrayBuffer());
}
