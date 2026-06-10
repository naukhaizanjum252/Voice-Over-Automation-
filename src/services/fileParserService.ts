import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';

/**
 * Extracts plain text from a file buffer based on extension or mimeType.
 */
export async function extractText(
  buffer: Buffer,
  fileName: string,
  mimeType?: string
): Promise<string> {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';

  switch (ext) {
    case 'txt':
    case 'md':
      return cleanText(buffer.toString('utf-8'));

    case 'doc':
    case 'docx':
      return extractFromDocx(buffer);

    case 'pdf':
      return extractFromPdf(buffer);

    default:
      // Fallback: use mimeType if extension is missing or unrecognized
      if (mimeType) {
        const mime = mimeType.toLowerCase();
        if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mime === 'application/msword') {
          return extractFromDocx(buffer);
        }
        if (mime === 'application/pdf') {
          return extractFromPdf(buffer);
        }
        if (mime === 'text/plain') {
          return cleanText(buffer.toString('utf-8'));
        }
      }

      // Last resort: try docx parser (most common script format)
      try {
        const text = await extractFromDocx(buffer);
        if (text && text.trim().length > 0) {
          console.log(`[fileParser] No extension/mime match for "${fileName}", but docx parser succeeded`);
          return text;
        }
      } catch {
        // not a docx
      }

      throw new Error(`Unsupported file type: .${ext} ${fileName.toLowerCase()}`);
  }
}

async function extractFromDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return cleanText(result.value);
}

async function extractFromPdf(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer);
  return cleanText(data.text);
}

/**
 * Cleans extracted text: normalizes whitespace, removes junk characters.
 */
function cleanText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')       // normalize line endings
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')          // tabs to spaces
    .replace(/ {2,}/g, ' ')       // collapse multiple spaces
    .replace(/\n{3,}/g, '\n\n')   // max 2 consecutive newlines
    .trim();
}
