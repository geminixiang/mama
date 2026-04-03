import { readFileSync } from "fs";

export interface SttConfig {
  provider: string;
  model: string;
  apiKey: string;
}

const PROVIDER_BASE_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
};

const PROVIDER_API_KEY_ENV: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
};

/**
 * Resolve STT API key from environment variables based on provider name.
 */
export function resolveSttApiKey(provider: string): string | undefined {
  const envVar = PROVIDER_API_KEY_ENV[provider];
  if (envVar) return process.env[envVar];
  // Fallback: try MOM_STT_API_KEY
  return process.env.MOM_STT_API_KEY;
}

/**
 * Get the audio format string from a filename extension.
 */
function getAudioFormat(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() || "";
  const FORMAT_MAP: Record<string, string> = {
    ogg: "ogg",
    oga: "ogg",
    mp3: "mp3",
    wav: "wav",
    flac: "flac",
    m4a: "m4a",
    aac: "aac",
    aiff: "aiff",
    mp4: "mp4",
  };
  return FORMAT_MAP[ext] || "ogg";
}

/**
 * Transcribe an audio file using a chat completions API with multimodal audio input.
 */
export async function transcribeAudio(filePath: string, config: SttConfig): Promise<string> {
  const fileBuffer = readFileSync(filePath);
  const base64Data = fileBuffer.toString("base64");
  const format = getAudioFormat(filePath);

  const baseUrl = PROVIDER_BASE_URLS[config.provider] || PROVIDER_BASE_URLS.openrouter;

  const body = {
    model: config.model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: { data: base64Data, format },
          },
          {
            type: "text",
            text: "Transcribe this audio faithfully. Output only the transcription text, nothing else.",
          },
        ],
      },
    ],
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`STT API error ${response.status}: ${errBody}`);
  }

  const result = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = result.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("STT API returned empty transcription");
  }

  return text.trim();
}
