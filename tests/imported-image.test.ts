import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import {
  IMPORTED_IMAGE_MAX_BYTES,
  ImportedImageError,
  validateImportedImage
} from '@/lib/projects/imported-image';

async function pngBase64(width = 8, height = 8): Promise<string> {
  return (await sharp({ create: { width, height, channels: 3, background: '#ff0000' } }).png().toBuffer()).toString('base64');
}

async function jpegBase64(): Promise<string> {
  return (await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00ff00' } }).jpeg().toBuffer()).toString('base64');
}

async function webpBase64(): Promise<string> {
  return (await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0000ff' } }).webp().toBuffer()).toString('base64');
}

describe('validateImportedImage', () => {
  it('accepts matching PNG, JPEG, and WebP payloads', async () => {
    const png = await pngBase64();
    expect(validateImportedImage({ filename: 'hero.png', mimeType: 'image/png', dataBase64: png })).toMatchObject({
      filename: 'hero.png',
      mimeType: 'image/png',
      width: 8,
      height: 8
    });

    const jpeg = await jpegBase64();
    expect(validateImportedImage({ filename: 'hero.jpg', mimeType: 'image/jpeg', dataBase64: jpeg }).mimeType).toBe('image/jpeg');
    expect(validateImportedImage({ filename: 'hero.jpeg', mimeType: 'image/jpeg', dataBase64: jpeg }).filename).toBe('hero.jpeg');

    const webp = await webpBase64();
    expect(validateImportedImage({ filename: 'hero.webp', mimeType: 'image/webp', dataBase64: webp }).mimeType).toBe('image/webp');
  });

  it('rejects invalid base64, data URLs, and paths', async () => {
    const png = await pngBase64();
    expect(() => validateImportedImage({ filename: 'hero.png', mimeType: 'image/png', dataBase64: '!!!!' })).toThrow(ImportedImageError);
    expect(() => validateImportedImage({ filename: 'hero.png', mimeType: 'image/png', dataBase64: `data:image/png;base64,${png}` })).toThrow(/dataBase64/);
    expect(() => validateImportedImage({ filename: 'hero.png', mimeType: 'image/png', dataBase64: 'https://example.com/x.png' })).toThrow(/dataBase64/);
    expect(() => validateImportedImage({ filename: 'hero.png', mimeType: 'image/png', dataBase64: '/tmp/hero.png' })).toThrow(/dataBase64/);
    expect(() => validateImportedImage({ filename: '../secret.png', mimeType: 'image/png', dataBase64: png })).toThrow(/filename/);
    expect(() => validateImportedImage({ filename: '/tmp/hero.png', mimeType: 'image/png', dataBase64: png })).toThrow(/filename/);
  });

  it('rejects MIME, extension, and byte mismatches', async () => {
    const png = await pngBase64();
    const jpeg = await jpegBase64();
    expect(() => validateImportedImage({ filename: 'hero.jpg', mimeType: 'image/png', dataBase64: png })).toThrow(/extension/);
    expect(() => validateImportedImage({ filename: 'hero.png', mimeType: 'image/jpeg', dataBase64: png })).toThrow(/extension|MIME/);
    expect(() => validateImportedImage({ filename: 'hero.jpg', mimeType: 'image/jpeg', dataBase64: png })).toThrow(/MIME type/);
    expect(() => validateImportedImage({ filename: 'hero.png', mimeType: 'image/png', dataBase64: jpeg })).toThrow(/MIME type/);
    expect(() => validateImportedImage({ filename: 'hero.gif', mimeType: 'image/png', dataBase64: png })).toThrow(ImportedImageError);
    expect(() => validateImportedImage({ filename: 'hero.png', mimeType: 'image/gif', dataBase64: png })).toThrow(ImportedImageError);
  });

  it('rejects corrupt bytes and empty payloads', () => {
    const junk = Buffer.from('not-an-image').toString('base64');
    expect(() => validateImportedImage({ filename: 'hero.png', mimeType: 'image/png', dataBase64: junk })).toThrow(/PNG, JPEG, or WebP/);
    expect(() => validateImportedImage({ filename: 'hero.png', mimeType: 'image/png', dataBase64: '' })).toThrow(ImportedImageError);
  });

  it('rejects payloads over 25 MB before storage', () => {
    const huge = Buffer.alloc(IMPORTED_IMAGE_MAX_BYTES + 1, 0).toString('base64');
    try {
      validateImportedImage({ filename: 'hero.png', mimeType: 'image/png', dataBase64: huge });
      throw new Error('expected too-large rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportedImageError);
      expect(error).toMatchObject({ code: 'asset.tooLarge', status: 413 });
    }
  });
});
