import { NextResponse } from 'next/server';

import { getImageGenerationConfigurationStatus } from '@/lib/ai/image-generation/registry';

export async function GET() {
  return NextResponse.json(getImageGenerationConfigurationStatus());
}
