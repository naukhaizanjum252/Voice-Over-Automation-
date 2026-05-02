/**
 * Merges multiple MP3 buffers into a single MP3 file.
 *
 * MP3 is a streamable format — concatenating valid MP3 frames produces a valid MP3 file.
 * This avoids needing ffmpeg on Vercel serverless functions.
 */
export function mergeAudioBuffers(buffers: Buffer[]): Buffer {
  if (buffers.length === 0) throw new Error('No audio buffers to merge');
  if (buffers.length === 1) return buffers[0];

  // Simple concatenation works for MP3 frames
  return Buffer.concat(buffers);
}
