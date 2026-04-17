import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function translateText(
  text: string,
  sourceLang: string,
  targetLang: string,
  retries = 2
): Promise<string> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Direct ${sourceLang} to ${targetLang} translation. NO fluff or preamble: "${text}"`
    });

    return response.text?.trim() || "Translation failed.";
  } catch (error) {
    if (retries > 0) {
      console.warn(`Translation failed, retrying... (${retries} attempts left)`);
      // Short delay before retry
      await new Promise(resolve => setTimeout(resolve, 500));
      return translateText(text, sourceLang, targetLang, retries - 1);
    }
    throw error;
  }
}
