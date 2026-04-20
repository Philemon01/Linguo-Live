import { GoogleGenAI, Type } from "@google/genai";

let aiInstance: GoogleGenAI | null = null;

function getAI() {
  if (!aiInstance) {
    const apiKey = typeof process !== 'undefined' ? process.env.GEMINI_API_KEY : undefined;
    if (!apiKey) {
      console.warn("GEMINI_API_KEY is not defined in the environment.");
    }
    aiInstance = new GoogleGenAI({ apiKey: apiKey || "" });
  }
  return aiInstance;
}

export interface TranslationResult {
  detectedLanguage: string;
  sourceText: string;
  translatedText: string;
}

export async function translateText(
  text: string,
  sourceLangName: string,
  targetLangName: string,
  retries = 2
): Promise<TranslationResult> {
  try {
    const ai = getAI();
    const isAuto = sourceLangName === 'Auto Detect';
    
    const systemInstruction = `You are a universal translation engine for the app "LinguoLive".
    Detect the source language and translate the input text.
    If the source language matches ${targetLangName}, translate it to English.
    Otherwise, translate it to ${targetLangName}.`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ parts: [{ text: `Translate this text: "${text}"` }] }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            detectedLanguage: { type: Type.STRING },
            sourceText: { type: Type.STRING },
            translatedText: { type: Type.STRING },
          },
          required: ["detectedLanguage", "sourceText", "translatedText"],
        },
      },
    });

    const rawText = response.text || "{}";
    
    // Improved extraction: find the first { and the last } to handle cases where the model
    // might add text before or after the JSON block.
    try {
      const match = rawText.match(/\{[\s\S]*\}/);
      const jsonStr = match ? match[0] : rawText;
      const result = JSON.parse(jsonStr);
      
      return {
        detectedLanguage: result.detectedLanguage || "Unknown",
        sourceText: text,
        translatedText: result.translatedText || "Translation failed."
      };
    } catch (parseError) {
      console.error("JSON Parse Error:", parseError, "Raw text:", rawText);
      // Fallback for non-JSON or malformed responses
      return {
        detectedLanguage: "Auto",
        sourceText: text,
        translatedText: rawText.replace(/\{[\s\S]*\}/, "").trim() || "Translation error."
      };
    }
  } catch (error) {
    if (retries > 0) {
      console.warn(`Translation failed, retrying... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, 500));
      return translateText(text, sourceLangName, targetLangName, retries - 1);
    }
    throw error;
  }
}
