import { VideoGenerationProviderError, type VideoGenerationCapabilities, type VideoGenerationDownload, type VideoGenerationProvider, type VideoGenerationRequest, type VideoGenerationStatusResult, type VideoGenerationSubmission } from './provider';

interface OpenAiVideoProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

function parseSafeErrorMessage(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const maybe = payload as { error?: { message?: string } };
    if (maybe.error?.message) {
      return maybe.error.message;
    }
  }
  return 'OpenAI video generation request failed.';
}

function mapAspectRatio(aspectRatio?: string): string | undefined {
  if (!aspectRatio) {
    return undefined;
  }
  if (aspectRatio === '16:9' || aspectRatio === '9:16' || aspectRatio === '1:1') {
    return aspectRatio;
  }
  throw new VideoGenerationProviderError(`Unsupported aspect ratio: ${aspectRatio}`, 422, 'UNSUPPORTED');
}

function normalizeProviderStatus(status: string): VideoGenerationStatusResult {
  const normalized = status.toLowerCase();
  if (normalized === 'queued' || normalized === 'submitted' || normalized === 'pending') {
    return { status: 'queued', providerStatus: status };
  }
  if (normalized === 'running' || normalized === 'processing' || normalized === 'in_progress' || normalized === 'generating') {
    return { status: 'generating', providerStatus: status };
  }
  if (normalized === 'succeeded' || normalized === 'completed' || normalized === 'done') {
    return { status: 'generated', providerStatus: status };
  }
  if (normalized === 'rejected' || normalized === 'blocked') {
    return { status: 'rejected', providerStatus: status, errorCode: 'PROVIDER_REJECTED', errorMessage: `Provider rejected job (${status}).` };
  }
  if (normalized === 'failed' || normalized === 'error' || normalized === 'cancelled') {
    return { status: 'failed', providerStatus: status, errorCode: 'PROVIDER_FAILED', errorMessage: `Provider reported failure (${status}).` };
  }

  return { status: 'generating', providerStatus: status };
}

export class OpenAiVideoGenerationProvider implements VideoGenerationProvider {
  readonly providerId = 'openai';

  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: OpenAiVideoProviderOptions = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY;
    this.model = options.model || process.env.OPENAI_VIDEO_MODEL || 'sora-1';
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';
  }

  getCapabilities(): VideoGenerationCapabilities {
    return {
      supportsTextToVideo: true,
      supportsImageToVideo: true,
      supportsReferences: true,
      maxReferences: 8,
      supportedAspectRatios: ['16:9', '1:1', '9:16'],
      supportsCancellation: false
    };
  }

  async submit(request: VideoGenerationRequest): Promise<VideoGenerationSubmission> {
    if (!this.apiKey) {
      throw new VideoGenerationProviderError('OpenAI video generation is not configured. Set OPENAI_API_KEY on the server.', 409, 'NOT_CONFIGURED');
    }

    if (!request.prompt.trim()) {
      throw new VideoGenerationProviderError('Prompt is required.', 400, 'INVALID_REQUEST');
    }

    const referenceImages = request.references ?? [];
    const payload = {
      model: request.model || this.model,
      prompt: request.prompt,
      aspect_ratio: mapAspectRatio(request.aspectRatio),
      duration_seconds: request.durationSeconds,
      // Provider-specific reference strategy is isolated in the adapter.
      references: referenceImages.map((reference) => ({
        filename: reference.filename || `${reference.id}.bin`,
        mime_type: reference.mimeType,
        data_base64: reference.data.toString('base64'),
        role: reference.role || 'reference'
      }))
    };

    const response = await fetch(`${this.baseUrl}/videos/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const body = (await response.json().catch(() => ({}))) as { id?: string; status?: string; error?: { message?: string } };

    if (!response.ok || !body.id) {
      const code = response.status === 401 || response.status === 403 ? 'PROVIDER_AUTH' : response.status === 429 ? 'PROVIDER_RATE_LIMIT' : response.status >= 400 && response.status < 500 ? 'PROVIDER_REJECTED' : 'PROVIDER_FAILED';
      throw new VideoGenerationProviderError(parseSafeErrorMessage(body), response.status >= 400 && response.status < 500 ? 422 : 502, code);
    }

    const mapped = normalizeProviderStatus(body.status || 'queued');
    return {
      providerJobId: body.id,
      status: mapped.status === 'queued' ? 'queued' : 'generating',
      providerStatus: mapped.providerStatus
    };
  }

  async getStatus(providerJobId: string): Promise<VideoGenerationStatusResult> {
    if (!this.apiKey) {
      throw new VideoGenerationProviderError('OpenAI video generation is not configured. Set OPENAI_API_KEY on the server.', 409, 'NOT_CONFIGURED');
    }

    const response = await fetch(`${this.baseUrl}/videos/generations/${encodeURIComponent(providerJobId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    });

    const body = (await response.json().catch(() => ({}))) as { status?: string; error?: { message?: string }; output?: { url?: string } };

    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? 'PROVIDER_AUTH' : response.status === 429 ? 'PROVIDER_RATE_LIMIT' : response.status >= 400 && response.status < 500 ? 'PROVIDER_REJECTED' : 'PROVIDER_FAILED';
      throw new VideoGenerationProviderError(parseSafeErrorMessage(body), response.status >= 400 && response.status < 500 ? 422 : 502, code);
    }

    const mapped = normalizeProviderStatus(body.status || 'generating');
    return {
      ...mapped,
      metadata: {
        outputUrl: body.output?.url
      }
    };
  }

  async download(providerJobId: string): Promise<VideoGenerationDownload> {
    if (!this.apiKey) {
      throw new VideoGenerationProviderError('OpenAI video generation is not configured. Set OPENAI_API_KEY on the server.', 409, 'NOT_CONFIGURED');
    }

    const status = await this.getStatus(providerJobId);
    const outputUrl = typeof status.metadata?.outputUrl === 'string' ? status.metadata.outputUrl : undefined;

    if (!outputUrl) {
      throw new VideoGenerationProviderError('Provider did not expose an output URL for the completed video job.', 502, 'DOWNLOAD_FAILED');
    }

    const response = await fetch(outputUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    });

    if (!response.ok) {
      throw new VideoGenerationProviderError('Failed to download generated video from provider output URL.', 502, 'DOWNLOAD_FAILED');
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get('content-type') || 'video/mp4';

    return {
      mimeType,
      data: bytes,
      metadata: {
        providerJobId
      }
    };
  }
}
