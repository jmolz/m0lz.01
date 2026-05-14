export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  size: string;
  quality: string;
}

export interface ImageGenerationResponse {
  bytes: Buffer;
  created?: number;
  model?: string;
}

export interface ImageProvider {
  generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResponse>;
}

interface OpenAIImageResponse {
  created?: number;
  data?: Array<{ b64_json?: string; revised_prompt?: string }>;
  error?: { message?: string; type?: string };
}

export const SUPPORTED_GPT_IMAGE_2_MODELS = new Set([
  'gpt-image-2-2026-04-21',
  'gpt-image-2',
]);

export class OpenAIImageProvider implements ImageProvider {
  constructor(private readonly apiKey = process.env.OPENAI_API_KEY) {}

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    if (!SUPPORTED_GPT_IMAGE_2_MODELS.has(request.model)) {
      throw new Error(`Unsupported OpenAI image model: ${request.model}`);
    }
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new Error('OPENAI_API_KEY is required for LinkedIn image generation');
    }

    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        size: request.size,
        quality: request.quality,
        n: 1,
        response_format: 'b64_json',
      }),
    });

    const raw = await response.text();
    let parsed: OpenAIImageResponse;
    try {
      parsed = JSON.parse(raw) as OpenAIImageResponse;
    } catch {
      throw new Error(`OpenAI image generation returned non-JSON response (status ${response.status})`);
    }

    if (!response.ok) {
      throw new Error(
        `OpenAI image generation failed (status ${response.status}): ` +
        `${parsed.error?.message ?? response.statusText}`,
      );
    }

    const encoded = parsed.data?.[0]?.b64_json;
    if (!encoded) {
      throw new Error('OpenAI image generation response did not include data[0].b64_json');
    }

    return {
      bytes: Buffer.from(encoded, 'base64'),
      created: parsed.created,
      model: request.model,
    };
  }
}
