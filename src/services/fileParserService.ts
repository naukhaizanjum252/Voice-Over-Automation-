import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';

/**
 * Extracts plain text from a file buffer based on extension.
 */
export async function extractText(
  buffer: Buffer,
  fileName: string
): Promise<string> {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';

  switch (ext) {
    case 'txt':
      return cleanText(buffer.toString('utf-8'));

    case 'doc':
    case 'docx':
      return extractFromDocx(buffer);

    case 'pdf':
      return extractFromPdf(buffer);

    default:
      throw new Error(`Unsupported file type: .${ext}`);
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
