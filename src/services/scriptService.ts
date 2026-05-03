import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/lib/env';

function getClient(): Anthropic {
  const key = env.anthropic.apiKey;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to your .env to enable script generation.');
  }
  return new Anthropic({ apiKey: key });
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

/**
 * Generates a script using Claude based on a master prompt and card title.
 * Returns the generated script text.
 */
export async function generateScript(
  masterPrompt: string,
  cardTitle: string
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const client = getClient();
      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        messages: [
          {
            role: 'user',
            content: `${masterPrompt}\n\nTitle: ${cardTitle}`,
          },
        ],
      });

      // Extract text from response
      const textBlock = message.content.find((block) => block.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('No text content in Claude response');
      }

      const script = textBlock.text.trim();
      if (!script) {
        throw new Error('Claude returned empty script');
      }

      console.log(
        `[scriptService] Generated script for "${cardTitle}": ${script.length} chars, ${message.usage.input_tokens}+${message.usage.output_tokens} tokens`
      );

      return script;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[scriptService] Attempt ${attempt}/${MAX_RETRIES} failed:`,
        lastError.message
      );

      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }
    }
  }

  throw lastError ?? new Error('Script generation failed after retries');
}
