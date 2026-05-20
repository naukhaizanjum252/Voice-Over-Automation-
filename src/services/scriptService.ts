import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { env } from "@/lib/env";

function getClient(): Anthropic {
  const key = env.anthropic.apiKey;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to your .env to enable script generation.",
    );
  }
  return new Anthropic({ apiKey: key });
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

/** How many correction passes to attempt when character count is off. */
const MAX_CORRECTION_PASSES = 3;
/** Acceptable tolerance: script must be within this % of the target. */
const CHAR_TOLERANCE_PERCENT = 2; // ±2%

/**
 * Configuration for script generation.
 * Maps to the user's 3-layer Claude workflow:
 *   Layer 1: primaryDocTexts (global instruction documents)
 *   Layer 2: feederScriptTexts (channel-level style examples)
 *   Layer 3: template fields (per-title prompt)
 */
export interface ScriptGenConfig {
  // Layer 1 — Primary instruction documents (global)
  primaryDocTexts: string[];
  // Layer 2 — Feeder scripts for style analysis (per-channel)
  feederScriptTexts?: string[];
  // Layer 3 — Template fields (per-channel, all optional)
  niche?: string | null;
  format?: string | null;
  length?: string | null;
  characterCount?: number | null;
  output?: string | null;
  note?: string | null;
}

/**
 * Generates a script using Claude.
 *
 * Prompt structure mirrors the user's manual Claude workflow:
 *   System: primary doc contents (instructions) + feeder scripts (style reference)
 *   User: templated prompt with all fields filled in
 *
 * If a character count target is set, uses a correction loop:
 *   1. Generate initial script
 *   2. Measure actual character count
 *   3. If outside ±2% tolerance, send a follow-up asking Claude to adjust
 *   4. Repeat up to MAX_CORRECTION_PASSES times
 */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export async function generateScript(
  config: ScriptGenConfig,
  cardTitle: string,
  model?: string,
): Promise<string> {
  const systemPrompt = buildSystemPrompt(config);
  const userPrompt = buildUserPrompt(config, cardTitle);
  const useModel = model || DEFAULT_MODEL;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const client = getClient();

      // Build initial conversation
      const messages: MessageParam[] = [
        { role: "user", content: userPrompt },
      ];

      const message = await client.messages.create({
        model: useModel,
        max_tokens: 16384,
        system: systemPrompt,
        messages,
      });

      let script = extractText(message);
      console.log(
        `[scriptService] Initial script for "${cardTitle}": ${script.length} chars, ${message.usage.input_tokens}+${message.usage.output_tokens} tokens`,
      );

      // If no character count target, return as-is
      const target = config.characterCount;
      if (!target) {
        return script;
      }

      // ── Correction loop ──
      const minChars = Math.round(target * (1 - CHAR_TOLERANCE_PERCENT / 100));
      const maxChars = Math.round(target * (1 + CHAR_TOLERANCE_PERCENT / 100));

      // Add the assistant's response to conversation history
      messages.push({ role: "assistant", content: script });

      for (let pass = 1; pass <= MAX_CORRECTION_PASSES; pass++) {
        const currentLen = script.length;

        if (currentLen >= minChars && currentLen <= maxChars) {
          console.log(
            `[scriptService] Character count OK: ${currentLen} chars (target: ${target}, tolerance: ${minChars}-${maxChars})`,
          );
          return script;
        }

        const diff = currentLen - target;
        const direction = diff > 0 ? "too long" : "too short";
        const absDiff = Math.abs(diff);

        console.log(
          `[scriptService] Correction pass ${pass}/${MAX_CORRECTION_PASSES}: ${currentLen} chars is ${direction} by ${absDiff} (target: ${target})`,
        );

        // Build correction prompt
        const correctionPrompt = buildCorrectionPrompt(currentLen, target, direction, absDiff);
        messages.push({ role: "user", content: correctionPrompt });

        const correctionMessage = await client.messages.create({
          model: useModel,
          max_tokens: 16384,
          system: systemPrompt,
          messages,
        });

        script = extractText(correctionMessage);
        console.log(
          `[scriptService] Correction pass ${pass} result: ${script.length} chars, ${correctionMessage.usage.input_tokens}+${correctionMessage.usage.output_tokens} tokens`,
        );

        // Update conversation history for next pass
        messages.push({ role: "assistant", content: script });
      }

      // After all correction passes, return whatever we have
      const finalLen = script.length;
      const finalDiff = Math.abs(finalLen - target);
      console.log(
        `[scriptService] Final script for "${cardTitle}": ${finalLen} chars (target: ${target}, diff: ${finalDiff}). Returning best result.`,
      );

      return script;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[scriptService] Attempt ${attempt}/${MAX_RETRIES} failed:`,
        lastError.message,
      );

      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_MS * attempt),
        );
      }
    }
  }

  throw lastError ?? new Error("Script generation failed after retries");
}

/** Extracts text from a Claude message response. */
function extractText(message: Anthropic.Message): string {
  const textBlock = message.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text content in Claude response");
  }
  const text = textBlock.text.trim();
  if (!text) {
    throw new Error("Claude returned empty script");
  }
  return text;
}

/** Builds the correction prompt for a specific overshoot/undershoot. */
function buildCorrectionPrompt(
  currentLen: number,
  target: number,
  direction: string,
  absDiff: number,
): string {
  if (direction === "too long") {
    return (
      `The script above is ${currentLen.toLocaleString()} characters. The target is ${target.toLocaleString()}. ` +
      `Remove exactly ${absDiff.toLocaleString()} characters from it. Do not change the tone, style, or voice. ` +
      `Output the full modified script only — no commentary.`
    );
  } else {
    return (
      `The script above is ${currentLen.toLocaleString()} characters. The target is ${target.toLocaleString()}. ` +
      `Add exactly ${absDiff.toLocaleString()} characters to it. Do not change the tone, style, or voice. ` +
      `Output the full modified script only — no commentary.`
    );
  }
}

/**
 * Builds the system prompt from primary docs + feeder scripts.
 * This is the "project knowledge" — persistent context for all scripts.
 */
function buildSystemPrompt(config: ScriptGenConfig): string {
  const sections: string[] = [];

  // Layer 1 — Primary instruction documents
  if (config.primaryDocTexts.length > 0) {
    const docsBlock = config.primaryDocTexts
      .map(
        (text, i) =>
          `<instruction_document_${i + 1}>\n${text}\n</instruction_document_${i + 1}>`,
      )
      .join("\n\n");
    sections.push(
      `<primary_instructions>\nThese are your core instructions. Follow them precisely for every script you write.\n\n${docsBlock}\n</primary_instructions>`,
    );
  }

  // Layer 2 — Feeder scripts for style analysis
  if (config.feederScriptTexts && config.feederScriptTexts.length > 0) {
    const feedersBlock = config.feederScriptTexts
      .map(
        (text, i) =>
          `<feeder_script_${i + 1}>\n${text}\n</feeder_script_${i + 1}>`,
      )
      .join("\n\n");
    sections.push(
      `<feeder_scripts>\nAnalyze the following scripts. Study their style, tone, pacing, and structure. Use them as a reference for the kind of script you should write — but do NOT copy them. Create original content.\n\n${feedersBlock}\n</feeder_scripts>`,
    );
  }

  // Hard constraint reminder
  sections.push(
    `<critical_rules>\n- If a character count is specified, hit it as precisely as possible. Aim for exactly that number of characters including spaces.\n- Output ONLY the script text. No titles, no headings, no metadata, no character counts.\n</critical_rules>`
  );

  return sections.join("\n\n");
}

/**
 * Builds the user prompt from template fields + title.
 * This mirrors the templated message the user sends in their manual flow.
 */
function buildUserPrompt(config: ScriptGenConfig, cardTitle: string): string {
  const lines: string[] = [];

  if (config.niche) {
    lines.push(`Niche: ${config.niche}`);
  }

  lines.push(`Write a faceless YouTube script.`);
  lines.push(`Topic: ${cardTitle}`);

  if (config.format) {
    lines.push(`Format: ${config.format}`);
  }
  if (config.length) {
    lines.push(`Length: ${config.length}`);
  }
  if (config.characterCount) {
    lines.push(`Character count: exactly ${config.characterCount.toLocaleString()} characters (including spaces). Hit this number precisely.`);
  }
  if (config.output) {
    lines.push(`Output: ${config.output}`);
  }
  if (config.note) {
    lines.push(`Note: ${config.note}`);
  }

  return lines.join("\n");
}
