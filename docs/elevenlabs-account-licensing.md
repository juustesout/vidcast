# ElevenLabs Account & Licensing Reference

Reference notes for the project's ElevenLabs usage. Informational only.

## Subscription Tier

- Starter Plan ($5/month base)

## Commercial Rights

- FULL COMMERCIAL LICENSE GRANTED.
  - All generated audio (Speech, Sound Effects, Music) may be used commercially in
    products, apps, videos, games, and media.
  - Attribution / source credit to ElevenLabs is NOT required.

## Usage & Quota

- Base allocation: 30,000 credits per month (~30 minutes of text-to-speech audio, or
  equivalent music/SFX length).
- Overage & top-ups: usage beyond the monthly quota is handled via Pay-As-You-Go (PAYG)
  auto top-up or manual top-up, billed per credit.
- Unused base monthly credits reset each billing cycle.
- Purchased top-up credits roll over until consumed.

## API Capabilities

- Full access to the ElevenLabs REST API and SDKs (Speech Synthesis, Sound Effects, and
  Music API).
- Full API key authentication enabled for server-side / background execution.

## Project Implications

- Commercial use of generated narration/music/SFX is permitted with no attribution.
- Server-side generation is supported (matches the existing server-run architecture).
- Cost/quota ceilings should still be respected: the run policy remains the single
  authority for real vs mock providers, and real narration requires `ELEVENLABS_API_KEY`.
