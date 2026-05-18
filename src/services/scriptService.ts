import Anthropic from "@anthropic-ai/sdk";
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
      const message = await client.messages.create({
        model: useModel,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });

      // Extract text from response
      const textBlock = message.content.find((block) => block.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("No text content in Claude response");
      }

      const script = textBlock.text.trim();
      if (!script) {
        throw new Error("Claude returned empty script");
      }

      console.log(
        `[scriptService] Generated script for "${cardTitle}": ${script.length} chars, ${message.usage.input_tokens}+${message.usage.output_tokens} tokens`,
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
    `<critical_rules>\n- If a character count is specified, it is a HARD LIMIT. You must produce a script that is within 5% below the target and never exceeds it. This is non-negotiable.\n- Output ONLY the script text. No titles, no headings, no metadata.\n</critical_rules>`
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
    lines.push(`Character count: EXACTLY ${config.characterCount.toLocaleString()} characters (this is a HARD LIMIT — the script MUST be between ${Math.round(config.characterCount * 0.95).toLocaleString()} and ${config.characterCount.toLocaleString()} characters including spaces. Do NOT exceed this limit and do NOT fall significantly short. Count carefully.)`);
  }
  if (config.output) {
    lines.push(`Output: ${config.output}`);
  }
  if (config.note) {
    lines.push(`Note: ${config.note}`);
  }

  return lines.join("\n");
}
